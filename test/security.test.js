// Authorization and input-validation tests for the non-payment Lambdas, with DynamoDB mocked

const ok = value => ({ promise: () => Promise.resolve(value) });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), query: jest.fn(), delete: jest.fn(), scan: jest.fn() };

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  CognitoIdentityServiceProvider: jest.fn(() => ({})),
}));

Object.assign(process.env, {
  BOOKINGS_TABLE: 'bookings',
  USERS_TABLE: 'users',
  PROFILES_TABLE: 'profiles',
  REVIEWS_TABLE: 'reviews',
  SCHEDULE_TABLE: 'schedule',
  NOTIFICATIONS_TABLE: 'notifications',
});

const bookings = require('../lib/lambdas/bookings');
const profiles = require('../lib/lambdas/profiles');
const schedule = require('../lib/lambdas/schedule');
const reviews = require('../lib/lambdas/reviews');
const pricing = require('../lib/lambdas/pricing');
const search = require('../lib/lambdas/search');
const { getUserId } = require('../lib/utils');
const { calculatePricing } = require('../lib/business-logic');

const HOMEOWNER = 'homeowner-1';
const TRADIE = 'tradie-1';

const apiEvent = (userId, { body, pathParameters, role } = {}) => ({
  requestContext: { authorizer: { claims: { sub: `sub-${userId}`, 'custom:userId': userId, 'custom:role': role } } },
  body: body ? JSON.stringify(body) : null,
  pathParameters,
});
const publicEvent = ({ pathParameters, queryStringParameters } = {}) => ({ pathParameters, queryStringParameters });

const booking = (overrides = {}) => ({
  bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE,
  date: '2099-01-05', startTime: '09:00', endTime: '11:00', status: 'accepted', ...overrides,
});

function mockTables(tables) {
  mockDb.get.mockImplementation(({ TableName }) => ok({ Item: tables[TableName] }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.put.mockReturnValue(ok({}));
  mockDb.update.mockReturnValue(ok({}));
  mockDb.query.mockReturnValue(ok({ Items: [] }));
});

describe('identity', () => {
  test('uses the immutable custom:userId that user records are keyed by', () => {
    expect(getUserId(apiEvent(TRADIE))).toBe(TRADIE);
  });
});

describe('bookings', () => {
  test('a booking is only visible to its homeowner and tradie', async () => {
    mockTables({ bookings: booking() });

    const stranger = await bookings.getBooking(apiEvent('stranger', { pathParameters: { bookingId: 'b1' } }));
    const tradie = await bookings.getBooking(apiEvent(TRADIE, { pathParameters: { bookingId: 'b1' } }));

    expect(stranger.statusCode).toBe(403);
    expect(tradie.statusCode).toBe(200);
  });

  test('only the tradie can mark a job completed', async () => {
    mockTables({ bookings: booking() });

    const res = await bookings.updateBooking(
      apiEvent(HOMEOWNER, { pathParameters: { bookingId: 'b1' }, body: { status: 'completed' } })
    );

    expect(res.statusCode).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('outsiders cannot change a booking at all', async () => {
    mockTables({ bookings: booking() });

    const res = await bookings.updateBooking(
      apiEvent('stranger', { pathParameters: { bookingId: 'b1' }, body: { status: 'completed' } })
    );

    expect(res.statusCode).toBe(403);
  });

  test('a paid booking cannot be cancelled without a refund', async () => {
    mockTables({ bookings: booking({ paymentStatus: 'paid' }) });

    const res = await bookings.updateBooking(
      apiEvent(HOMEOWNER, { pathParameters: { bookingId: 'b1' }, body: { status: 'cancelled' } })
    );

    expect(res.statusCode).toBe(409);
  });

  test('reviewed can only be reached by leaving a review', async () => {
    mockTables({ bookings: booking({ status: 'completed' }) });

    const res = await bookings.updateBooking(
      apiEvent(HOMEOWNER, { pathParameters: { bookingId: 'b1' }, body: { status: 'reviewed' } })
    );

    expect(res.statusCode).toBe(400);
  });

  test('bookings must name a real tradie', async () => {
    mockTables({ users: { userId: 'someone', role: 'homeowner' } });

    const res = await bookings.createBooking(apiEvent(HOMEOWNER, {
      body: { tradieId: 'someone', date: '2099-01-05', startTime: '09:00', endTime: '11:00', jobType: 'Plumbing' },
    }));

    expect(res.statusCode).toBe(404);
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test.each([
    [{ startTime: '11:00', endTime: '09:00' }],
    [{ startTime: '9am', endTime: '11:00' }],
    [{ date: '2099-02-30' }],
    [{ date: '2000-01-01' }],
  ])('rejects invalid booking times %o', async (overrides) => {
    const res = await bookings.createBooking(apiEvent(HOMEOWNER, {
      body: { tradieId: TRADIE, date: '2099-01-05', startTime: '09:00', endTime: '11:00', jobType: 'Plumbing', ...overrides },
    }));

    expect(res.statusCode).toBe(400);
  });

  test('respects the tradie\'s days off', async () => {
    mockTables({ users: { userId: TRADIE, role: 'tradie' } });
    mockDb.query.mockImplementation(({ TableName }) => ok({
      Items: TableName === 'schedule' ? [{ scheduleType: 'unavailable-2099-01-05' }] : [],
    }));

    const res = await bookings.createBooking(apiEvent(HOMEOWNER, {
      body: { tradieId: TRADIE, date: '2099-01-05', startTime: '09:00', endTime: '11:00', jobType: 'Plumbing' },
    }));

    expect(res.statusCode).toBe(409);
  });
});

describe('profiles and search', () => {
  test('public tradie profiles do not expose email addresses', async () => {
    mockTables({ users: { userId: TRADIE, role: 'tradie', email: 'tradie@example.com', hourlyRate: 90 } });

    const res = await profiles.getTradieProfile(publicEvent({ pathParameters: { tradieId: TRADIE } }));

    expect(JSON.parse(res.body).email).toBeUndefined();
  });

  test('public homeowner profiles do not expose email addresses', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner', email: 'home@example.com' } });

    const res = await profiles.getHomeownerProfile(publicEvent({ pathParameters: { homeownerId: HOMEOWNER } }));

    expect(JSON.parse(res.body).email).toBeUndefined();
  });

  test('search results do not expose email addresses', async () => {
    mockDb.scan.mockReturnValue(ok({ Items: [{ userId: TRADIE, role: 'tradie', email: 'tradie@example.com' }] }));

    const res = await search.searchTradies(publicEvent({ queryStringParameters: {} }));

    expect(JSON.parse(res.body).tradies[0].email).toBeUndefined();
  });

  test('search leaves out tradies who have not verified their email', async () => {
    mockDb.scan.mockReturnValue(ok({ Items: [] }));

    await search.searchTradies(publicEvent({ queryStringParameters: {} }));

    expect(mockDb.scan.mock.calls[0][0].FilterExpression).toContain('emailVerified = :verified');
  });

  test.each([[-50], [0], ['abc'], [5000]])('rejects hourly rate %p', async (hourlyRate) => {
    mockTables({ users: { userId: TRADIE, role: 'tradie' } });

    const res = await profiles.updateProfile(apiEvent(TRADIE, { body: { hourlyRate } }));

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('users cannot grant themselves HomeLink Pro through their profile', async () => {
    mockTables({ users: { userId: TRADIE, role: 'tradie' } });

    await profiles.updateProfile(apiEvent(TRADIE, { body: { hasHomeinkPro: true, bio: 'hi' } }));

    const written = mockDb.update.mock.calls.map(([p]) => JSON.stringify(p)).join(' ');
    expect(written).not.toContain('hasHomeinkPro');
  });

  test('homeowners cannot register a tradie profile', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner' } });

    const res = await profiles.registerTradie(apiEvent(HOMEOWNER, { body: { trade: 'Plumbing', hourlyRate: 90 } }));

    expect(res.statusCode).toBe(403);
  });
});

describe('schedule', () => {
  const hours = { Monday: { start: '09:00', end: '17:00' } };

  test('only tradies can set working hours', async () => {
    const res = await schedule.updateSchedule(apiEvent(HOMEOWNER, { role: 'homeowner', body: { workingHours: hours } }));

    expect(res.statusCode).toBe(403);
  });

  test('extra fields are not stored', async () => {
    const res = await schedule.updateSchedule(apiEvent(TRADIE, {
      role: 'tradie', body: { workingHours: { Monday: { start: '09:00', end: '17:00', junk: 'x'.repeat(1000) } } },
    }));

    expect(res.statusCode).toBe(200);
    expect(mockDb.put.mock.calls[0][0].Item.workingHours).toEqual({ Monday: { start: '09:00', end: '17:00' } });
  });

  test('rejects unknown days and bad travel buffers', async () => {
    const unknownDay = await schedule.updateSchedule(apiEvent(TRADIE, { role: 'tradie', body: { workingHours: { Funday: {} } } }));
    const badBuffer = await schedule.updateSchedule(apiEvent(TRADIE, { role: 'tradie', body: { workingHours: hours, travelBuffer: -5 } }));

    expect(unknownDay.statusCode).toBe(400);
    expect(badBuffer.statusCode).toBe(400);
  });

  test('days off are returned as full dates', async () => {
    mockDb.get.mockReturnValue(ok({}));
    mockDb.query.mockReturnValue(ok({ Items: [{ scheduleType: 'unavailable-2099-01-05' }] }));

    const res = await schedule.getSchedule(publicEvent({ pathParameters: { tradieId: TRADIE } }));

    expect(JSON.parse(res.body).unavailableDates).toEqual(['2099-01-05']);
  });
});

describe('reviews', () => {
  test.each([['5'], [4.5], [0], ['abc']])('rejects rating %p', async (rating) => {
    const res = await reviews.createReview(apiEvent(HOMEOWNER, { body: { bookingId: 'b1', rating } }));

    expect(res.statusCode).toBe(400);
  });
});

describe('pricing', () => {
  test('pricing breakdowns are only visible to the booking\'s participants', async () => {
    mockTables({ bookings: booking(), users: { userId: TRADIE, hourlyRate: 90 } });

    const res = await pricing.getPricingBreakdown(apiEvent('stranger', { pathParameters: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(403);
  });

  test('the homeowner price covers Stripe\'s card fee', () => {
    const quote = calculatePricing(90, 2.5, false);
    const stripeFee = Math.round(quote.homeownerPays * 100 * 0.0165) / 100 + 0.30;

    expect(quote.homeownerPays).toBe(240.52);
    // HomeLink still nets its full 5% fee + 10% commission after Stripe's cut
    expect(quote.applicationFee - stripeFee).toBeCloseTo(11.25 + 22.5, 1);
  });

  test('Pro tradies keep the whole job price', () => {
    const quote = calculatePricing(90, 2.5, true);

    expect(quote.tradieEarns).toBe(225);
    expect(quote.tradieCommission).toBe(0);
  });
});
