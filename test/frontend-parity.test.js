// Arrival tracking, rescheduling, the price guide and multi-origin CORS, with DynamoDB mocked

const ok = value => ({ promise: () => Promise.resolve(value) });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), query: jest.fn(), delete: jest.fn(), scan: jest.fn() };

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  CognitoIdentityServiceProvider: jest.fn(() => ({})),
}));

Object.assign(process.env, {
  BOOKINGS_TABLE: 'bookings',
  USERS_TABLE: 'users',
  SCHEDULE_TABLE: 'schedule',
  NOTIFICATIONS_TABLE: 'notifications',
});

const bookings = require('../lib/lambdas/bookings');
const pricing = require('../lib/lambdas/pricing');
const { corsHeaders } = require('../lib/utils');
const { calculatePricing, estimateJobPrice } = require('../lib/business-logic');

const HOMEOWNER = 'homeowner-1';
const TRADIE = 'tradie-1';

const apiEvent = (userId, { body, pathParameters, headers } = {}) => ({
  requestContext: { authorizer: { claims: { sub: `sub-${userId}`, 'custom:userId': userId } } },
  body: body ? JSON.stringify(body) : null,
  pathParameters,
  headers,
});
const patch = (userId, body) => bookings.updateBooking(apiEvent(userId, { pathParameters: { bookingId: 'b1' }, body }));

// 2099-01-05 is a Monday, inside the default 09:00-17:00 working hours
const booking = (overrides = {}) => ({
  bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE,
  date: '2099-01-05', startTime: '09:00', endTime: '11:00', status: 'accepted', ...overrides,
});

function mockTables(tables) {
  mockDb.get.mockImplementation(({ TableName }) => ok({ Item: tables[TableName] }));
}

const lastUpdate = () => mockDb.update.mock.calls[mockDb.update.mock.calls.length - 1][0];
const notifications = () => mockDb.put.mock.calls
  .map(([params]) => params)
  .filter(params => params.TableName === 'notifications')
  .map(params => params.Item);

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.put.mockReturnValue(ok({}));
  mockDb.update.mockReturnValue(ok({}));
  mockDb.query.mockReturnValue(ok({ Items: [] }));
});

describe('arrival tracking', () => {
  test('the tradie can share that they are on the way without a status change', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, { arrivalStatus: 'en-route', etaMinutes: 25 });

    expect(res.statusCode).toBe(200);
    const update = lastUpdate();
    expect(update.ExpressionAttributeValues).toMatchObject({ ':arrival': 'en-route', ':eta': 25, ':accepted': 'accepted' });
    expect(update.ConditionExpression).toBe('tradieId = :uid AND #status = :accepted');
    expect(notifications()).toEqual([expect.objectContaining({
      userId: HOMEOWNER, type: 'tradie-en-route', message: 'Your tradie is on the way and about 25 minutes away',
    })]);
  });

  test('accepts on_the_way as a spelling of en-route', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, { arrivalStatus: 'on_the_way', etaMinutes: 10 });

    expect(res.statusCode).toBe(200);
    expect(lastUpdate().ExpressionAttributeValues[':arrival']).toBe('en-route');
  });

  test('arriving notifies the homeowner and clears the ETA', async () => {
    mockTables({ bookings: booking({ arrivalStatus: 'en-route', etaMinutes: 5 }) });

    const res = await patch(TRADIE, { arrivalStatus: 'arrived' });

    expect(res.statusCode).toBe(200);
    expect(lastUpdate().UpdateExpression).toMatch(/REMOVE etaMinutes/);
    expect(notifications()).toEqual([expect.objectContaining({ userId: HOMEOWNER, type: 'tradie-arrived' })]);
  });

  test('ETA updates while already on the way do not notify again', async () => {
    mockTables({ bookings: booking({ arrivalStatus: 'en-route', etaMinutes: 20 }) });

    const res = await patch(TRADIE, { etaMinutes: 12 });

    expect(res.statusCode).toBe(200);
    expect(notifications()).toEqual([]);
  });

  test('stores only the coordinates of a live location', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, {
      liveLocation: { latitude: -33.87, longitude: 151.21, accuracy: 12, note: 'ignored' },
    });

    expect(res.statusCode).toBe(200);
    const values = lastUpdate().ExpressionAttributeValues;
    expect(values[':loc']).toEqual({ latitude: -33.87, longitude: 151.21, accuracy: 12 });
    expect(values[':sharing']).toBe(true);
    expect(new Date(values[':locAt']).toString()).not.toBe('Invalid Date');
  });

  test.each([
    [{ liveLocation: { latitude: 91, longitude: 151 } }],
    [{ liveLocation: { latitude: '-33.8', longitude: 151 } }],
    [{ liveLocation: { latitude: -33.8 } }],
    [{ liveLocation: { latitude: -33.8, longitude: 151, accuracy: -1 } }],
    [{ liveLocation: null }],
    [{ arrivalStatus: 'en-route', etaMinutes: -5 }],
    [{ arrivalStatus: 'en-route', etaMinutes: 'soon' }],
    [{ arrivalStatus: 'en-route', etaMinutes: 5000 }],
    [{ arrivalStatus: 'teleported' }],
    [{ etaMinutes: 10 }],
    [{ stopLocationSharing: false }],
    [{ stopLocationSharing: true, liveLocation: { latitude: 0, longitude: 0 } }],
  ])('rejects invalid arrival update %j', async body => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, body);

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('only the booking\'s tradie can send arrival updates', async () => {
    mockTables({ bookings: booking() });

    const homeowner = await patch(HOMEOWNER, { arrivalStatus: 'arrived' });
    const stranger = await patch('stranger', { liveLocation: { latitude: 0, longitude: 0 } });

    expect(homeowner.statusCode).toBe(403);
    expect(stranger.statusCode).toBe(403);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test.each(['pending', 'completed', 'cancelled'])('no arrival updates on a %s booking', async status => {
    mockTables({ bookings: booking({ status }) });

    const res = await patch(TRADIE, { liveLocation: { latitude: -33.8, longitude: 151.2 } });

    expect(res.statusCode).toBe(409);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('stopping location sharing clears the location, even after the job ended', async () => {
    mockTables({ bookings: booking({ status: 'completed' }) });

    const res = await patch(TRADIE, { stopLocationSharing: true });

    expect(res.statusCode).toBe(200);
    const update = lastUpdate();
    expect(update.UpdateExpression).toMatch(/REMOVE liveLocation, locationUpdatedAt$/);
    expect(update.ExpressionAttributeValues[':sharing']).toBe(false);
    expect(update.ConditionExpression).toBe('tradieId = :uid');
  });

  test('a booking that changed meanwhile is a conflict, not a server error', async () => {
    mockTables({ bookings: booking() });
    mockDb.update.mockReturnValue({
      promise: () => Promise.reject(Object.assign(new Error('failed'), { code: 'ConditionalCheckFailedException' })),
    });

    const res = await patch(TRADIE, { liveLocation: { latitude: -33.8, longitude: 151.2 } });

    expect(res.statusCode).toBe(409);
  });

  test.each(['completed', 'cancelled'])('the live location is cleared when the job is %s', async status => {
    const actor = status === 'completed' ? TRADIE : HOMEOWNER;
    mockTables({ bookings: booking({ locationSharing: true, liveLocation: { latitude: 1, longitude: 2 } }) });

    const res = await patch(actor, { status });

    expect(res.statusCode).toBe(200);
    expect(lastUpdate().UpdateExpression).toMatch(/locationSharing = :sharing REMOVE liveLocation, locationUpdatedAt/);
  });

  test('accepting a booking does not touch the location', async () => {
    mockTables({ bookings: booking({ status: 'pending' }) });

    await patch(TRADIE, { status: 'accepted' });

    expect(lastUpdate().UpdateExpression).not.toMatch(/REMOVE/);
  });

  test('status changes and arrival updates go in separate requests', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, { status: 'completed', arrivalStatus: 'arrived' });

    expect(res.statusCode).toBe(400);
  });

  test('an empty update is rejected', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(TRADIE, {});

    expect(res.statusCode).toBe(400);
  });
});

describe('rescheduling', () => {
  test.each([[HOMEOWNER, TRADIE], [TRADIE, HOMEOWNER]])('%s can move the booking and %s is notified', async (actor, other) => {
    mockTables({ bookings: booking() });

    const res = await patch(actor, { date: '2099-01-06', startTime: '13:00', endTime: '15:00' });

    expect(res.statusCode).toBe(200);
    const update = lastUpdate();
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':date': '2099-01-06', ':start': '13:00', ':end': '15:00', ':by': actor,
      ':previous': { date: '2099-01-05', startTime: '09:00', endTime: '11:00' },
    });
    expect(update.UpdateExpression).toMatch(/bookingDate = :date/);
    expect(update.UpdateExpression).toMatch(/REMOVE arrivalStatus, arrivalUpdatedAt, etaMinutes, liveLocation, locationUpdatedAt/);
    expect(update.ConditionExpression).toMatch(/attribute_not_exists\(paymentStatus\)/);
    expect(notifications()).toEqual([expect.objectContaining({ userId: other, type: 'booking-rescheduled' })]);
  });

  test('keeps the existing date when only the times change', async () => {
    mockTables({ bookings: booking() });

    const res = await patch(HOMEOWNER, { startTime: '14:00', endTime: '16:00' });

    expect(res.statusCode).toBe(200);
    expect(lastUpdate().ExpressionAttributeValues[':date']).toBe('2099-01-05');
  });

  test('re-checks availability against the tradie\'s other bookings, ignoring this one', async () => {
    mockTables({ bookings: booking() });
    mockDb.query.mockImplementation(({ IndexName }) => ok({
      Items: IndexName === 'TradieIdIndex'
        ? [booking(), booking({ bookingId: 'b2', startTime: '13:00', endTime: '14:00' })]
        : [],
    }));

    // Overlapping only itself is fine
    const shift = await patch(HOMEOWNER, { startTime: '09:30', endTime: '11:30' });
    // Inside b2's travel buffer is not
    const clash = await patch(HOMEOWNER, { startTime: '14:00', endTime: '16:00' });

    expect(shift.statusCode).toBe(200);
    expect(clash.statusCode).toBe(409);
    expect(JSON.parse(clash.body).error).toMatch(/booked/);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  test('respects working hours and days off', async () => {
    mockTables({ bookings: booking() });

    const weekend = await patch(HOMEOWNER, { date: '2099-01-10' });
    const evening = await patch(HOMEOWNER, { startTime: '18:00', endTime: '20:00' });

    expect(weekend.statusCode).toBe(409);
    expect(evening.statusCode).toBe(409);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test.each([
    [{ date: '2099-02-30' }],
    [{ date: '2000-01-03' }],
    [{ startTime: '9am' }],
    [{ startTime: '12:00', endTime: '11:00' }],
    [{ date: '2099-01-05', startTime: '09:00', endTime: '11:00' }],
  ])('rejects invalid reschedule %j', async body => {
    mockTables({ bookings: booking() });

    const res = await patch(HOMEOWNER, body);

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test.each(['declined', 'completed', 'cancelled', 'reviewed'])('a %s booking cannot be rescheduled', async status => {
    mockTables({ bookings: booking({ status }) });

    const res = await patch(HOMEOWNER, { date: '2099-01-06' });

    expect(res.statusCode).toBe(409);
  });

  test('outsiders cannot reschedule', async () => {
    mockTables({ bookings: booking() });

    const res = await patch('stranger', { date: '2099-01-06' });

    expect(res.statusCode).toBe(403);
  });

  test('a paid booking can move to a slot of the same length', async () => {
    const tradie = { userId: TRADIE, role: 'tradie', hourlyRate: 100 };
    const paid = calculatePricing(100, 2).homeownerPays;
    mockTables({ bookings: booking({ paymentStatus: 'paid', paymentAmount: paid }), users: tradie });

    const res = await patch(HOMEOWNER, { date: '2099-01-07', startTime: '10:00', endTime: '12:00' });

    expect(res.statusCode).toBe(200);
    expect(lastUpdate().ConditionExpression).toMatch(/paymentStatus = :ps/);
  });

  test('a paid booking cannot be repriced by rescheduling', async () => {
    const tradie = { userId: TRADIE, role: 'tradie', hourlyRate: 100 };
    const paid = calculatePricing(100, 2).homeownerPays;
    mockTables({ bookings: booking({ paymentStatus: 'paid', paymentAmount: paid }), users: tradie });

    const res = await patch(HOMEOWNER, { startTime: '09:00', endTime: '12:00' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/paid/);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('a paid booking cannot move if the tradie\'s rate has changed since', async () => {
    const paid = calculatePricing(100, 2).homeownerPays;
    mockTables({
      bookings: booking({ paymentStatus: 'paid', paymentAmount: paid }),
      users: { userId: TRADIE, role: 'tradie', hourlyRate: 120 },
    });

    const res = await patch(TRADIE, { date: '2099-01-06' });

    expect(res.statusCode).toBe(409);
  });
});

describe('price estimate', () => {
  const estimate = body => pricing.estimatePrice({ body: JSON.stringify(body), headers: {} });
  const tradies = (...rates) => rates.map((hourlyRate, i) => ({
    userId: `t${i}`, role: 'tradie', trade: 'Plumbing', hourlyRate, location: i % 2 ? 'Parramatta' : 'Bondi',
  }));

  test('uses the 25th-75th percentile of the trade\'s rates, from the trade index', async () => {
    mockDb.query.mockReturnValue(ok({ Items: tradies(80, 100, 120, 140, 160) }));

    const res = await estimate({ trade: 'Plumbing', durationHours: 2 });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      currency: 'AUD',
      low: 150, // $100/h x 1.5h
      high: 420, // $140/h x 3h
      hours: { low: 1.5, high: 3 },
      sampleSize: 5,
      source: 'marketplace',
      includesServiceFee: false,
      disclaimer: expect.any(String),
    });
    expect(mockDb.query).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'users', IndexName: 'TradeRateIndex', ExpressionAttributeValues: { ':trade': 'Plumbing' },
    }));
    expect(mockDb.scan).not.toHaveBeenCalled();
  });

  test('accepts a lower-case trade name', async () => {
    mockDb.query.mockReturnValue(ok({ Items: [] }));

    await estimate({ trade: 'plumbing', durationHours: 2 });

    const trades = mockDb.query.mock.calls.map(([params]) => params.ExpressionAttributeValues[':trade']);
    expect(trades).toEqual(['plumbing', 'Plumbing']);
  });

  test('prefers tradies in the homeowner\'s area when there are enough', async () => {
    // Bondi: 80, 120, 160 · Parramatta: 100, 140, 300
    mockDb.query.mockReturnValue(ok({ Items: tradies(80, 100, 120, 140, 160, 300) }));

    const local = JSON.parse((await estimate({ trade: 'Plumbing', location: 'bondi', durationHours: 1 })).body);
    const fallback = JSON.parse((await estimate({ trade: 'Plumbing', location: 'Penrith', durationHours: 1 })).body);

    expect(local.sampleSize).toBe(3);
    expect(fallback.sampleSize).toBe(6);
  });

  test('skips unverified tradies and implausible rates', async () => {
    mockDb.query.mockReturnValue(ok({
      Items: [...tradies(100, 120), { userId: 'x', role: 'tradie', hourlyRate: 90, emailVerified: false }, ...tradies(5, 900)],
    }));

    const res = JSON.parse((await estimate({ trade: 'Plumbing', durationHours: 2 })).body);

    expect(res.sampleSize).toBe(2);
  });

  test('pages through the index', async () => {
    mockDb.query
      .mockReturnValueOnce(ok({ Items: tradies(100), LastEvaluatedKey: { userId: 't0' } }))
      .mockReturnValueOnce(ok({ Items: tradies(120) }));

    const res = JSON.parse((await estimate({ trade: 'Plumbing', durationHours: 2 })).body);

    expect(res.sampleSize).toBe(2);
    expect(mockDb.query.mock.calls[1][0].ExclusiveStartKey).toEqual({ userId: 't0' });
  });

  test('falls back to a baseline rate with no marketplace data', async () => {
    const res = JSON.parse((await estimate({ trade: 'Electrical', durationHours: 2 })).body);

    expect(res).toMatchObject({ source: 'baseline', sampleSize: 0, low: 140, high: 380 });
  });

  test.each([
    [{ durationHours: 2 }],
    [{ trade: '', durationHours: 2 }],
    [{ trade: 'x'.repeat(101), durationHours: 2 }],
    [{ trade: 'Plumbing' }],
    [{ trade: 'Plumbing', durationHours: '2' }],
    [{ trade: 'Plumbing', durationHours: 0.25 }],
    [{ trade: 'Plumbing', durationHours: 25 }],
    [{ trade: 'Plumbing', durationHours: 2, location: 7 }],
    [{ trade: 'Plumbing', durationHours: 2, description: 'x'.repeat(2001) }],
  ])('rejects invalid input %j', async body => {
    const res = await estimate(body);

    expect(res.statusCode).toBe(400);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('matches the frontend\'s offline estimate for a single rate', () => {
    expect(estimateJobPrice('Plumbing', [100], 4)).toMatchObject({ low: 255, high: 690, hours: { low: 3, high: 6 } });
  });
});

describe('CORS', () => {
  const origins = 'https://homelink.example,capacitor://localhost,https://localhost';
  afterEach(() => { delete process.env.ALLOWED_ORIGINS; });

  test.each(['https://homelink.example', 'capacitor://localhost', 'https://localhost'])('allows %s', origin => {
    process.env.ALLOWED_ORIGINS = origins;

    expect(corsHeaders({ headers: { Origin: origin } })).toEqual({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  });

  test('does not allow other origins', () => {
    process.env.ALLOWED_ORIGINS = origins;

    expect(corsHeaders({ headers: { origin: 'https://evil.example' } })).toEqual({ Vary: 'Origin' });
    expect(corsHeaders({})).toEqual({ Vary: 'Origin' });
  });

  test('allows any origin until origins are configured', () => {
    expect(corsHeaders({ headers: { origin: 'https://anything.example' } }))
      .toEqual({ 'Access-Control-Allow-Origin': '*', Vary: 'Origin' });
  });

  test('handler responses echo the caller\'s allowed origin', async () => {
    process.env.ALLOWED_ORIGINS = origins;
    mockTables({ bookings: booking() });

    const app = await bookings.getBooking(apiEvent(TRADIE, {
      pathParameters: { bookingId: 'b1' }, headers: { origin: 'capacitor://localhost' },
    }));
    const other = await bookings.getBooking(apiEvent(TRADIE, {
      pathParameters: { bookingId: 'b1' }, headers: { origin: 'https://evil.example' },
    }));

    expect(app.headers).toMatchObject({ 'Access-Control-Allow-Origin': 'capacitor://localhost', Vary: 'Origin' });
    expect(other.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(other.headers.Vary).toBe('Origin');
  });

  test('every Lambda ships the same utils.js and business-logic.js', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'lib');
    for (const dir of fs.readdirSync(path.join(root, 'lambdas'))) {
      for (const file of ['utils.js', 'business-logic.js']) {
        expect(fs.readFileSync(path.join(root, 'lambdas', dir, file), 'utf8'))
          .toBe(fs.readFileSync(path.join(root, file), 'utf8'));
      }
    }
  });
});

describe('stack', () => {
  const cdk = require('aws-cdk-lib');
  const { Template, Match } = require('aws-cdk-lib/assertions');
  const { HomeLinkStack } = require('../lib/stack');
  const synth = context => Template.fromStack(
    new HomeLinkStack(new cdk.App({ context }), 'TestStack', { env: { region: 'ap-southeast-2' } })
  );

  const template = synth({
    allowedOrigins: 'capacitor://localhost, https://localhost,https://staging.example.amplifyapp.com/',
    frontendUrl: 'https://homelink.example',
  });

  test('passes every allowed origin to the Lambdas', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({
        ALLOWED_ORIGINS: 'capacitor://localhost,https://localhost,https://staging.example.amplifyapp.com,https://homelink.example',
      }) },
    });
  });

  test('preflight responses echo an allowed origin', () => {
    const options = Object.values(template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'OPTIONS' },
    }));
    const preflight = JSON.stringify(options[0].Properties.Integration);
    expect(preflight).toContain('capacitor://localhost');
    expect(preflight).toContain('Vary');
  });

  test('the price guide is a public POST /pricing/estimate backed by a trade index', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'estimate' });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
      Integration: Match.objectLike({
        Uri: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([
          Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('EstimatePricingFunction')]) }),
        ])]) }),
      }),
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: 'TradeRateIndex',
        KeySchema: [{ AttributeName: 'trade', KeyType: 'HASH' }, { AttributeName: 'hourlyRate', KeyType: 'RANGE' }],
      })]),
    });
  });

  test('allows any origin when none is configured', () => {
    synth({}).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ALLOWED_ORIGINS: '*' }) },
    });
  });
});
