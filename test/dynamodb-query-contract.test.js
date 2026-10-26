const fs = require('fs');
const path = require('path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('DynamoDB query contracts', () => {
  test('availability queries the tradie/date index directly', () => {
    const code = source('lib/lambdas/availability/index.js');
    const direct = "KeyConditionExpression: 'tradieId = :tradieId AND bookingDate = :date'";
    expect(code.split(direct)).toHaveLength(4);
    expect(code).not.toContain("FilterExpression: 'bookingDate = :date AND");
  });

  test('booking conflict checks use the same tradie/date key', () => {
    const code = source('lib/lambdas/bookings/index.js');
    expect(code).toContain("KeyConditionExpression: 'tradieId = :tradieId AND bookingDate = :date'");
    expect(code).not.toContain("FilterExpression: 'bookingDate = :date AND");
  });

  test('search ratings are calculated from reviews', () => {
    const code = source('lib/lambdas/search/index.js');
    expect(code).toContain('const REVIEWS_TABLE = process.env.REVIEWS_TABLE');
    expect(code).toContain('const ratingMap = {}');
    expect(code).not.toContain('rating: profile.rating || 0');
  });

  test('payments use accepted bookings, server pricing, and Secrets Manager', () => {
    const code = source('lib/lambdas/payments/index.js');
    expect(code).toContain("booking.status !== 'accepted'");
    expect(code).not.toContain("booking.status !== 'confirmed'");
    expect(code).toContain('amountForBooking(booking)');
    expect(code).toContain('STRIPE_SECRET_NAME');
    expect(code).toContain('finalizePayment(paymentIntent, booking)');
    expect(code).toContain('`stripe-${paymentIntent.id}`');
  });

  test('booking updates support explicit arrival status and ETA', () => {
    const code = source('lib/lambdas/bookings/index.js');
    expect(code).toContain("['en-route', 'arrived'].includes(arrivalStatus)");
    expect(code).toContain("'arrival-update'");
  });

  test('live locations are tradie-only, validated, and removed when tracking ends', () => {
    const code = source('lib/lambdas/bookings/index.js');
    expect(code).toContain("Only the tradie can share a live location");
    expect(code).toContain('latitude < -90 || latitude > 90');
    expect(code).toContain('longitude < -180 || longitude > 180');
    expect(code).toContain('REMOVE liveLocation');
  });

  test('new requests store a confirmed job address and coordinates', () => {
    const code = source('lib/lambdas/bookings/index.js');
    expect(code).toContain('serviceAddress, serviceLocation');
    expect(code).toContain('serviceAddress: cleanAddress');
    expect(code).toContain('serviceLocation: { latitude, longitude, accuracy }');
  });

  test('calendar time blocks are exposed and wired to authenticated routes', () => {
    const schedule = source('lib/lambdas/schedule/index.js');
    const stack = source('lib/stack.js');
    expect(schedule).toContain('async function createTimeBlock');
    expect(schedule).toContain("scheduleType: `block-${blockId}`");
    expect(stack).toContain("'schedule.createTimeBlock'");
    expect(stack).toContain("'schedule.removeTimeBlock'");
  });

  test('account deletion is initiated in-app and retained for operational cleanup', () => {
    const auth = source('lib/lambdas/auth/index.js');
    const stack = source('lib/stack.js');
    expect(auth).toContain('async function requestAccountDeletion');
    expect(auth).toContain("accountStatus = :status");
    expect(auth).toContain("'deletion_requested'");
    expect(auth).toContain('within 30 days');
    expect(stack).toContain("'auth.requestAccountDeletion'");
    expect(stack).toContain("meResource.addMethod('DELETE'");
  });

  test('the stack targets Sydney and exposes the payments table to Lambdas', () => {
    const app = source('bin/homelink-26-backend.js');
    expect(app).toContain("process.env.HOMELINK_AWS_REGION || 'ap-southeast-2'");
    expect(app).not.toContain('CDK_DEFAULT_REGION');
    expect(source('lib/stack.js')).toContain('PAYMENTS_TABLE: tables.paymentsTable.tableName');
  });
});
