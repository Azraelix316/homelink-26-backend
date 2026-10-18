// Display names on bookings: stored at creation, filled in on read for older bookings

const ok = value => ({ promise: () => Promise.resolve(value) });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), query: jest.fn(), batchGet: jest.fn() };

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
}));

Object.assign(process.env, {
  BOOKINGS_TABLE: 'bookings',
  USERS_TABLE: 'users',
  SCHEDULE_TABLE: 'schedule',
  NOTIFICATIONS_TABLE: 'notifications',
});

const bookings = require('../lib/lambdas/bookings');

const signedIn = (userId, extra = {}) => ({ requestContext: { authorizer: { claims: { 'custom:userId': userId } } }, ...extra });
const bodyOf = res => JSON.parse(res.body);
const USERS = {
  'tradie-1': { userId: 'tradie-1', role: 'tradie', name: 'Sam Spark' },
  'homeowner-1': { userId: 'homeowner-1', role: 'homeowner', name: 'Jo Home' },
  'homeowner-2': { userId: 'homeowner-2', role: 'homeowner', name: 'Alex Owner' },
};

function batchGetFrom(users) {
  return ({ RequestItems }) => ok({
    Responses: { users: RequestItems.users.Keys.map(({ userId }) => users[userId]).filter(Boolean) },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.put.mockReturnValue(ok({}));
  mockDb.query.mockReturnValue(ok({ Items: [] }));
  mockDb.get.mockImplementation(({ TableName, Key }) => ok({ Item: TableName === 'users' ? USERS[Key.userId] : undefined }));
  mockDb.batchGet.mockImplementation(batchGetFrom(USERS));
});

test('a new booking stores both people\'s names', async () => {
  const res = await bookings.createBooking(signedIn('homeowner-1', {
    body: JSON.stringify({ tradieId: 'tradie-1', date: '2099-01-05', startTime: '09:00', endTime: '10:00', jobType: 'Lighting' }),
  }));

  expect(res.statusCode).toBe(201);
  expect(mockDb.put.mock.calls.find(([p]) => p.TableName === 'bookings')[0].Item).toMatchObject({
    tradieName: 'Sam Spark', homeownerName: 'Jo Home',
  });
});

test('older bookings get names filled in on read, without being rewritten', async () => {
  mockDb.query.mockReturnValue(ok({
    Items: [
      { bookingId: 'old', tradieId: 'tradie-1', homeownerId: 'homeowner-2' },
      { bookingId: 'new', tradieId: 'tradie-1', homeownerId: 'homeowner-1', tradieName: 'Sam S.', homeownerName: 'Jo H.' },
    ],
  }));

  const res = await bookings.getUserBookings(signedIn('tradie-1', { queryStringParameters: { role: 'tradie' } }));
  const [old, current] = bodyOf(res).bookings;

  expect(old).toMatchObject({ tradieName: 'Sam Spark', homeownerName: 'Alex Owner' });
  // Stored names win: they are the snapshot taken when the booking was made
  expect(current).toMatchObject({ tradieName: 'Sam S.', homeownerName: 'Jo H.' });
  expect(mockDb.batchGet.mock.calls[0][0].RequestItems.users.Keys).toEqual([{ userId: 'tradie-1' }, { userId: 'homeowner-2' }]);
  expect(mockDb.update).not.toHaveBeenCalled();
  expect(mockDb.put).not.toHaveBeenCalled();
});

test('no lookup when every booking already has names', async () => {
  mockDb.query.mockReturnValue(ok({ Items: [{ bookingId: 'b', tradieId: 't', homeownerId: 'h', tradieName: 'T', homeownerName: 'H' }] }));

  await bookings.getUserBookings(signedIn('h', { queryStringParameters: { role: 'homeowner' } }));

  expect(mockDb.batchGet).not.toHaveBeenCalled();
});

test('unprocessed keys are retried', async () => {
  mockDb.query.mockReturnValue(ok({ Items: [{ bookingId: 'old', tradieId: 'tradie-1', homeownerId: 'homeowner-1' }] }));
  mockDb.batchGet
    .mockReturnValueOnce(ok({ Responses: { users: [USERS['tradie-1']] }, UnprocessedKeys: { users: { Keys: [{ userId: 'homeowner-1' }] } } }))
    .mockImplementation(batchGetFrom(USERS));

  const res = await bookings.getUserBookings(signedIn('homeowner-1', { queryStringParameters: { role: 'homeowner' } }));

  expect(bodyOf(res).bookings[0]).toMatchObject({ tradieName: 'Sam Spark', homeownerName: 'Jo Home' });
  expect(mockDb.batchGet).toHaveBeenCalledTimes(2);
});

test('a deleted user leaves an empty name rather than failing the list', async () => {
  mockDb.query.mockReturnValue(ok({ Items: [{ bookingId: 'old', tradieId: 'gone', homeownerId: 'homeowner-1' }] }));

  const res = await bookings.getUserBookings(signedIn('homeowner-1', { queryStringParameters: { role: 'homeowner' } }));

  expect(res.statusCode).toBe(200);
  expect(bodyOf(res).bookings[0]).toMatchObject({ tradieName: '', homeownerName: 'Jo Home' });
});

test('a single booking also comes back with names', async () => {
  mockDb.get.mockImplementation(({ TableName }) => ok({
    Item: TableName === 'bookings' ? { bookingId: 'old', tradieId: 'tradie-1', homeownerId: 'homeowner-1' } : undefined,
  }));

  const res = await bookings.getBooking(signedIn('homeowner-1', { pathParameters: { bookingId: 'old' } }));

  expect(bodyOf(res)).toMatchObject({ tradieName: 'Sam Spark', homeownerName: 'Jo Home' });
});
