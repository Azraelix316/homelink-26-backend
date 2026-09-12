const { getUserId, isHomeowner } = require('../lib/utils.js');
const { isSlotAvailable } = require('../lib/business-logic.js');

describe('live booking contract', () => {
  test('uses the application user id stored in Cognito claims', () => {
    const event = {
      requestContext: {
        authorizer: {
          claims: {
            sub: 'cognito-sub',
            'custom:userId': 'app-user-id',
            'custom:role': 'homeowner',
          },
        },
      },
    };

    expect(getUserId(event)).toBe('app-user-id');
    expect(isHomeowner(event.requestContext.authorizer.claims)).toBe(true);
  });

  test('keeps the Cognito sub as a fallback for older users', () => {
    expect(getUserId({ requestContext: { authorizer: { claims: { sub: 'legacy-id' } } } })).toBe('legacy-id');
  });

  test('rejects a slot already occupied by a pending booking', () => {
    const schedule = { Monday: { start: '09:00', end: '17:00' } };
    const booking = {
      date: '2026-09-14',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
    };

    expect(isSlotAvailable('2026-09-14', '10:00', '11:00', schedule, [], [booking], 0)).toEqual({
      available: false,
      reason: 'booked',
    });
  });
});
