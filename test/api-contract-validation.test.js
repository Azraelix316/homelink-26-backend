const { execFileSync } = require('child_process');
const path = require('path');

const authenticatedEvent = (body, queryStringParameters) => ({
  body: JSON.stringify(body || {}),
  queryStringParameters,
  requestContext: {
    authorizer: {
      claims: { 'custom:userId': 'user-1' },
    },
  },
});

function runHandler(moduleName, exportName, event) {
  const handlerPath = path.join(__dirname, '..', 'lib', 'lambdas', moduleName, 'index.js');
  const script = [
    "const handler = require(process.argv[2])[process.argv[3]];",
    "handler(JSON.parse(process.argv[1])).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => { console.error(error); process.exit(1); });",
  ].join('');
  const output = execFileSync(process.execPath, [
    '-e', script, JSON.stringify(event), handlerPath, exportName,
  ], { encoding: 'utf8' });
  return JSON.parse(output);
}

const parsedBody = (result) => JSON.parse(result.body);

describe('api contract validation', () => {
  test('pricing rejects non-numeric legacy inputs', () => {
    const result = runHandler('pricing', 'calculatePrice', {
      body: JSON.stringify({ hourlyRate: 'nope', hours: 2 }),
    });
    expect(result.statusCode).toBe(400);
    expect(parsedBody(result).error).toMatch(/valid tradie or hourly rate/i);
  });

  test('schedule rejects invalid travel buffers before writing', () => {
    const result = runHandler('schedule', 'updateSchedule', authenticatedEvent({
      workingHours: { Monday: { start: '09:00', end: '17:00' } },
      travelBuffer: -1,
    }));
    expect(result.statusCode).toBe(400);
  });

  test('schedule rejects impossible unavailable dates', () => {
    const result = runHandler('schedule', 'markUnavailable', authenticatedEvent({ date: '2026-02-31' }));
    expect(result.statusCode).toBe(400);
  });

  test('tradie onboarding rejects a non-numeric hourly rate', () => {
    const result = runHandler('profiles', 'registerTradie', authenticatedEvent({
      trade: 'Plumbing',
      hourlyRate: 'not-a-number',
    }));
    expect(result.statusCode).toBe(400);
  });

  test('reviews require a whole-number rating', () => {
    const result = runHandler('reviews', 'createReview', authenticatedEvent({
      bookingId: 'booking-1',
      rating: 4.5,
    }));
    expect(result.statusCode).toBe(400);
  });

  test('notifications validate limit and offset', () => {
    const result = runHandler('notifications', 'getNotifications', authenticatedEvent(
      {},
      { limit: '0', offset: '-1' }
    ));
    expect(result.statusCode).toBe(400);
  });
});