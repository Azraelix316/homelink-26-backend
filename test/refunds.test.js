// Refund and cancellation flow: policy rules and handlers, with DynamoDB,
// Secrets Manager and Stripe mocked. The feature is off unless REFUNDS_ENABLED.

const ok = value => ({ promise: () => Promise.resolve(value) });
const fail = error => ({ promise: () => Promise.reject(error) });
const conditionalCheckFailed = () => Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), query: jest.fn() };
const mockSecrets = { getSecretValue: jest.fn() };
const mockStripe = {
  refunds: { create: jest.fn() },
  transfers: { createReversal: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
};

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  SecretsManager: jest.fn(() => mockSecrets),
}));
jest.mock('stripe', () => jest.fn(() => mockStripe));

const BASE_ENV = {
  BOOKINGS_TABLE: 'bookings',
  PAYMENTS_TABLE: 'payments',
  NOTIFICATIONS_TABLE: 'notifications',
  USERS_TABLE: 'users',
  STRIPE_SECRET_ID: 'homelink/stripe',
};
Object.assign(process.env, BASE_ENV);

const payments = require('../lib/lambdas/payments');
const { readPolicy, quoteRefund, zonedTimeToEpoch } = require('../lib/lambdas/payments/refunds');

const HOMEOWNER = 'homeowner-1';
const TRADIE = 'tradie-1';
// A$225 job: 225 + 11.25 service fee + 4.27 processing = 240.52; tradie earns 202.50
const BREAKDOWN = { homeownerPays: 24052, subtotal: 22500, serviceFee: 1125, processingFee: 427, tradieEarns: 20250, applicationFee: 3802 };

/** A Sydney wall-clock date and time `hours` from now. */
function sydneyIn(hours) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(Date.now() + hours * 3600000)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, startTime: `${parts.hour}:${parts.minute}` };
}

const booking = (overrides = {}) => ({
  bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE, status: 'accepted', paymentStatus: 'paid',
  paymentId: 'pay_1', stripePaymentIntentId: 'pi_1', paymentBreakdown: BREAKDOWN, ...sydneyIn(24 * 5), endTime: '23:59',
  ...overrides,
});
const apiEvent = (userId, { body, pathParameters } = {}) => ({
  requestContext: { authorizer: { claims: { 'custom:userId': userId } } },
  body: body ? JSON.stringify(body) : null,
  pathParameters,
});
const bodyOf = res => JSON.parse(res.body);
const quote = (userId, bookingId = 'b1') => payments.refundQuote(apiEvent(userId, { pathParameters: { bookingId } }));
const cancel = (userId, extra = {}) => payments.cancelPaidBooking(apiEvent(userId, { body: { bookingId: 'b1', ...extra } }));

function withPolicy(env) {
  for (const key of Object.keys(process.env)) if (key.startsWith('REFUND')) delete process.env[key];
  Object.assign(process.env, { REFUNDS_ENABLED: 'true', ...env });
}

beforeEach(() => {
  jest.clearAllMocks();
  withPolicy({});
  mockSecrets.getSecretValue.mockReturnValue(ok({ SecretString: JSON.stringify({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }) }));
  mockDb.get.mockReturnValue(ok({ Item: booking() }));
  mockDb.update.mockReturnValue(ok({}));
  mockDb.put.mockReturnValue(ok({}));
  mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });
  mockStripe.transfers.createReversal.mockResolvedValue({ id: 'trr_1' });
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', latest_charge: { id: 'ch_1', transfer: 'tr_1' } });
});

describe('policy', () => {
  test('is off by default, with placeholder values', () => {
    expect(readPolicy({})).toEqual({
      enabled: false, cutoffHours: 24, latePercent: 50, keepServiceFee: true, keepProcessingFee: true, timeZone: 'Australia/Sydney',
    });
  });

  test('reads every value from configuration, within sensible bounds', () => {
    expect(readPolicy({
      REFUNDS_ENABLED: 'true', REFUND_CUTOFF_HOURS: '48', REFUND_LATE_PERCENT: '150',
      REFUND_KEEP_SERVICE_FEE: 'false', REFUND_KEEP_PROCESSING_FEE: 'false', BUSINESS_TIMEZONE: 'Australia/Perth',
    })).toEqual({
      enabled: true, cutoffHours: 48, latePercent: 100, keepServiceFee: false, keepProcessingFee: false, timeZone: 'Australia/Perth',
    });
    expect(readPolicy({ REFUND_LATE_PERCENT: 'lots' }).latePercent).toBe(50);
  });

  const policy = overrides => ({ ...readPolicy({}), ...overrides });
  const balances = (q) => q.refundCents + (BREAKDOWN.tradieEarns - q.tradieReversalCents) + q.platformKeepsCents;

  test('a tradie cancelling refunds everything and takes back their whole payout', () => {
    const q = quoteRefund(policy(), BREAKDOWN, 'tradie', 1);
    expect(q).toMatchObject({ refundCents: 24052, tradieReversalCents: 20250, platformKeepsCents: 0, rule: 'tradie-cancelled' });
  });

  test('a homeowner cancelling before the cut-off gets the job price back, fees as configured', () => {
    expect(quoteRefund(policy(), BREAKDOWN, 'homeowner', 48)).toMatchObject({ refundCents: 22500, tradieReversalCents: 20250, rule: 'before-cutoff' });
    expect(quoteRefund(policy({ keepServiceFee: false }), BREAKDOWN, 'homeowner', 48).refundCents).toBe(23625);
    expect(quoteRefund(policy({ keepServiceFee: false, keepProcessingFee: false }), BREAKDOWN, 'homeowner', 48).refundCents).toBe(24052);
  });

  test('a late cancellation refunds the configured share, and the tradie keeps the rest', () => {
    const q = quoteRefund(policy({ latePercent: 50 }), BREAKDOWN, 'homeowner', 3);
    expect(q).toMatchObject({ refundCents: 11250, tradieReversalCents: 10125, rule: 'after-cutoff' });
    expect(quoteRefund(policy({ latePercent: 0 }), BREAKDOWN, 'homeowner', 3)).toMatchObject({ refundCents: 0, tradieReversalCents: 0 });
  });

  test.each([[48, 'homeowner'], [3, 'homeowner'], [1, 'tradie']])('every cent is accounted for (%ih, %s)', (hours, who) => {
    expect(balances(quoteRefund(policy(), BREAKDOWN, who, hours))).toBe(BREAKDOWN.homeownerPays);
  });

  test('converts Sydney wall-clock times across daylight saving', () => {
    expect(new Date(zonedTimeToEpoch('2026-11-03', '09:00', 'Australia/Sydney')).toISOString()).toBe('2026-11-02T22:00:00.000Z');
    expect(new Date(zonedTimeToEpoch('2026-07-01', '09:00', 'Australia/Sydney')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
    // The morning daylight saving starts (2:00 jumps to 3:00 on 4 Oct 2026)
    expect(new Date(zonedTimeToEpoch('2026-10-04', '09:00', 'Australia/Sydney')).toISOString()).toBe('2026-10-03T22:00:00.000Z');
  });
});

describe('feature flag', () => {
  test('both endpoints refuse while refunds are off, without touching data or Stripe', async () => {
    withPolicy({ REFUNDS_ENABLED: 'false' });

    for (const res of [await quote(HOMEOWNER), await cancel(HOMEOWNER)]) {
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res).code).toBe('REFUNDS_DISABLED');
    }
    expect(mockDb.get).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe('refund quote', () => {
  test('tells the homeowner what they would get back', async () => {
    const res = await quote(HOMEOWNER);

    expect(bodyOf(res)).toEqual({
      bookingId: 'b1', cancelledBy: 'homeowner', rule: 'before-cutoff', refund: 225, paid: 240.52,
      tradieGivesBack: 202.5, currency: 'AUD', cutoffHours: 24,
    });
  });

  test('a late cancellation is quoted under the late rule', async () => {
    mockDb.get.mockReturnValue(ok({ Item: booking(sydneyIn(3)) }));

    expect(bodyOf(await quote(HOMEOWNER))).toMatchObject({ rule: 'after-cutoff', refund: 112.5 });
  });

  test.each([
    ['someone not on the booking', 'stranger', booking(), 403],
    ['an unpaid booking', HOMEOWNER, booking({ paymentStatus: 'payment_pending' }), 409],
    ['a completed job', HOMEOWNER, booking({ status: 'completed' }), 409],
    ['a job that has started', HOMEOWNER, booking(sydneyIn(-1)), 409],
    ['a booking paid before refunds existed', HOMEOWNER, booking({ paymentBreakdown: undefined }), 409],
    ['a refund already under way', HOMEOWNER, booking({ refundStatus: 'processing' }), 409],
  ])('refuses %s', async (_, userId, item, status) => {
    mockDb.get.mockReturnValue(ok({ Item: item }));

    expect((await quote(userId)).statusCode).toBe(status);
  });
});

describe('cancel a paid booking', () => {
  test('refunds the card and takes back the tradie\'s share, with exact amounts', async () => {
    const res = await cancel(HOMEOWNER, { reason: 'Plans changed' });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ status: 'cancelled', paymentStatus: 'partially_refunded', refund: 225, refundId: 're_1' });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 22500, reverse_transfer: false, refund_application_fee: false, metadata: { bookingId: 'b1', cancelledBy: 'homeowner' } },
      { idempotencyKey: 'refund-b1-22500' },
    );
    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1', { expand: ['latest_charge'] });
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_1', { amount: 20250, metadata: { bookingId: 'b1', cancelledBy: 'homeowner' } }, { idempotencyKey: 'reversal-b1-20250' },
    );
  });

  test('locks the booking first, then records the cancellation and tells the tradie', async () => {
    await cancel(HOMEOWNER, { reason: 'Plans changed' });

    const [lock, done, paymentRecord] = mockDb.update.mock.calls.map(([p]) => p);
    expect(lock.ConditionExpression).toContain('paymentStatus = :paid');
    expect(lock.ConditionExpression).toContain('attribute_not_exists(refundStatus) OR refundStatus = :failed');
    expect(done.ExpressionAttributeValues).toMatchObject({
      ':cancelled': 'cancelled', ':ps': 'partially_refunded', ':succeeded': 'succeeded', ':rid': 're_1', ':tid': 'trr_1',
      ':ra': 225, ':ta': 202.5, ':by': 'homeowner', ':reason': 'Plans changed',
    });
    expect(paymentRecord).toMatchObject({ TableName: 'payments', Key: { paymentId: 'pay_1' } });
    expect(mockDb.put.mock.calls[0][0].Item).toMatchObject({ userId: TRADIE, type: 'booking-cancelled' });
  });

  test('a tradie cancelling refunds in full and tells the homeowner', async () => {
    const res = await cancel(TRADIE);

    expect(bodyOf(res)).toMatchObject({ cancelledBy: 'tradie', paymentStatus: 'refunded', refund: 240.52 });
    expect(mockStripe.refunds.create.mock.calls[0][0].amount).toBe(24052);
    expect(mockDb.put.mock.calls[0][0].Item.userId).toBe(HOMEOWNER);
  });

  test('with nothing to refund, Stripe is not called and the payment stands', async () => {
    withPolicy({ REFUND_LATE_PERCENT: '0' });
    mockDb.get.mockReturnValue(ok({ Item: booking(sydneyIn(2)) }));

    const res = await cancel(HOMEOWNER);

    expect(bodyOf(res)).toMatchObject({ status: 'cancelled', paymentStatus: 'paid', refund: 0, refundId: null });
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(mockStripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  test('two cancellations at once refund only once', async () => {
    mockDb.update.mockReturnValueOnce(fail(conditionalCheckFailed()));

    const res = await cancel(HOMEOWNER);

    expect(res.statusCode).toBe(409);
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  test('if Stripe fails, the booking is unlocked for a retry and nothing is marked cancelled', async () => {
    mockStripe.refunds.create.mockRejectedValue(new Error('card_declined'));

    const res = await cancel(HOMEOWNER);

    expect(res.statusCode).toBe(502);
    const updates = mockDb.update.mock.calls.map(([p]) => p.ExpressionAttributeValues);
    expect(updates.at(-1)).toMatchObject({ ':failed': 'failed' });
    expect(updates.some(v => v[':cancelled'])).toBe(false);
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test('a missing transfer stops the cancellation instead of under-recovering', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', latest_charge: { id: 'ch_1', transfer: null } });

    const res = await cancel(HOMEOWNER);

    expect(res.statusCode).toBe(502);
  });

  test('rejects an over-long reason', async () => {
    expect((await cancel(HOMEOWNER, { reason: 'x'.repeat(501) })).statusCode).toBe(400);
  });
});

describe('payment breakdown', () => {
  test('is stored when a payment starts, so refunds use the price actually charged', async () => {
    mockDb.get.mockImplementation(({ TableName }) => ok({
      Item: TableName === 'users'
        ? { userId: TRADIE, role: 'tradie', hourlyRate: 90, stripeAccountId: 'acct_1', stripeChargesEnabled: true }
        : booking({ paymentStatus: undefined, stripePaymentIntentId: undefined, paymentBreakdown: undefined, startTime: '09:00', endTime: '11:30' }),
    }));
    mockStripe.paymentIntents.create = jest.fn().mockResolvedValue({ id: 'pi_new', amount: 24052, currency: 'aud' });

    await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(mockDb.update.mock.calls[0][0].ExpressionAttributeValues[':breakdown']).toEqual(BREAKDOWN);
  });
});
