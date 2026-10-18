// GET /availability/tradie/{id} as the frontend calendar calls it, with DynamoDB mocked

const ok = value => ({ promise: () => Promise.resolve(value) });

const mockDb = { get: jest.fn(), query: jest.fn() };

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
}));

Object.assign(process.env, { BOOKINGS_TABLE: 'bookings', SCHEDULE_TABLE: 'schedule', USERS_TABLE: 'users' });

const availability = require('../lib/lambdas/availability');

const week = (query) => ({ pathParameters: { tradieId: 't1' }, queryStringParameters: query });
const bodyOf = res => JSON.parse(res.body);

// 2099-01-05 is a Monday
const FROM = '2099-01-05';
const TO = '2099-01-11';

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.get.mockReturnValue(ok({}));
  mockDb.query.mockImplementation(({ TableName }) => ok({ Items: TableName === 'schedule' ? [] : [] }));
});

test('a from/to range returns every day with slots the calendar can draw', async () => {
  const res = await availability.getAvailability(week({ from: FROM, to: TO }));
  const days = bodyOf(res).availabilityByDate;

  expect(res.statusCode).toBe(200);
  expect(Object.keys(days)).toEqual(['2099-01-05', '2099-01-06', '2099-01-07', '2099-01-08', '2099-01-09', '2099-01-10', '2099-01-11']);
  expect(days['2099-01-05']).toMatchObject({ availableCount: 8, hours: [9, 10, 11, 12, 13, 14, 15, 16] });
  expect(days['2099-01-05'].slots).toHaveLength(24);
  expect(days['2099-01-10'].slots.every(slot => slot.reason === 'off-hours')).toBe(true);
});

test('booked hours (with the travel buffer) and days off are marked', async () => {
  mockDb.query.mockImplementation(({ TableName }) => ok({
    Items: TableName === 'schedule'
      ? [{ scheduleType: 'unavailable-2099-01-07' }]
      : [{ bookingId: 'b1', date: '2099-01-06', bookingDate: '2099-01-06', startTime: '10:00', endTime: '11:00', status: 'accepted' }],
  }));

  const days = bodyOf(await availability.getAvailability(week({ from: FROM, to: TO }))).availabilityByDate;
  const tuesday = Object.fromEntries(days['2099-01-06'].slots.map(slot => [slot.hour, slot.reason]));

  expect(tuesday[9]).toBe('booked'); // within 30 minutes of the 10:00 job
  expect(tuesday[10]).toBe('booked');
  expect(tuesday[12]).toBe('available');
  expect(days['2099-01-07'].availableCount).toBe(0);
});

test('reads the whole range in one paged query, not one per day', async () => {
  let bookingQueries = 0;
  mockDb.query.mockImplementation(({ TableName, ExclusiveStartKey }) => {
    if (TableName === 'schedule') return ok({ Items: [] });
    bookingQueries += 1;
    return ok(ExclusiveStartKey
      ? { Items: [{ date: '2099-01-08', startTime: '13:00', endTime: '14:00', status: 'pending' }] }
      : { Items: [], LastEvaluatedKey: { bookingId: 'x' } });
  });

  const days = bodyOf(await availability.getAvailability(week({ from: FROM, to: TO }))).availabilityByDate;

  expect(bookingQueries).toBe(2);
  expect(days['2099-01-08'].hours).not.toContain(13);
});

test.each([
  [{ from: FROM }],
  [{ from: TO, to: FROM }],
  [{ from: '2099-01-01', to: '2099-06-01' }],
  [{ from: 'monday', to: TO }],
])('rejects range %o', async (query) => {
  expect((await availability.getAvailability(week(query))).statusCode).toBe(400);
});

test('a single ?date= still works as before', async () => {
  const res = await availability.getAvailability(week({ date: FROM }));

  expect(res.statusCode).toBe(200);
  expect(bodyOf(res).slots).toHaveLength(24);
});
