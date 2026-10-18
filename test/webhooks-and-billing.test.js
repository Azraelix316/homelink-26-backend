// Stripe webhook edge cases, payout status, Pro billing portal and payment lookups,
// with DynamoDB, Secrets Manager and Stripe mocked (no real keys)

const ok = value => ({ promise: () => Promise.resolve(value) });
const fail = error => ({ promise: () => Promise.reject(error) });
const conditionalCheckFailed = () => Object.assign(new Error('The conditional request failed'), {
  code: 'ConditionalCheckFailedException',
});

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), query: jest.fn() };
const mockSecrets = { getSecretValue: jest.fn() };
const mockStripe = {
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
  customers: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  SecretsManager: jest.fn(() => mockSecrets),
}));
jest.mock('stripe', () => jest.fn(() => mockStripe));

Object.assign(process.env, {
  BOOKINGS_TABLE: 'bookings',
  USERS_TABLE: 'users',
  PAYMENTS_TABLE: 'payments',
  NOTIFICATIONS_TABLE: 'notifications',
  STRIPE_SECRET_ID: 'homelink/stripe',
  FRONTEND_URL: 'https://app.example.com',
});

const payments = require('../lib/lambdas/payments');

const HOMEOWNER = 'homeowner-1';
const TRADIE = 'tradie-1';
const SECRET = { secretKey: 'sk_test_x', webhookSecret: 'whsec_platform', connectWebhookSecret: 'whsec_connect' };

const apiEvent = (userId, { body, pathParameters } = {}) => ({
  requestContext: { authorizer: { claims: { 'custom:userId': userId } } },
  body: body ? JSON.stringify(body) : null,
  pathParameters,
});
const bodyOf = res => JSON.parse(res.body);
const tradie = (overrides = {}) => ({
  userId: TRADIE, role: 'tradie', hourlyRate: 100, email: 't@example.com', ...overrides,
});
const booking = (overrides = {}) => ({
  bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE, startTime: '09:00', endTime: '11:00',
  status: 'accepted', ...overrides,
});

function mockTables(tables) {
  mockDb.get.mockImplementation(({ TableName }) => ok({ Item: tables[TableName] }));
}

function webhook(type, object, { headers = { 'Stripe-Signature': 'sig' }, body = '{"id":"evt"}', isBase64Encoded = false } = {}) {
  mockStripe.webhooks.constructEvent.mockReturnValue({ type, created: 100, data: { object } });
  return payments.handleWebhook({ headers, body, isBase64Encoded });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSecrets.getSecretValue.mockReturnValue(ok({ SecretString: JSON.stringify(SECRET) }));
  mockDb.put.mockReturnValue(ok({}));
  mockDb.update.mockReturnValue(ok({}));
});

describe('webhook signature handling', () => {
  test('a base64-encoded body is decoded to the exact raw bytes before verification', async () => {
    const raw = '{"id":"evt_1","object":"event"}';

    await webhook('charge.refunded', {}, { body: Buffer.from(raw).toString('base64'), isBase64Encoded: true });

    const [payload] = mockStripe.webhooks.constructEvent.mock.calls[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(payload.toString()).toBe(raw);
  });

  test('events from the Connect endpoint verify with the Connect signing secret', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation((payload, sig, secret) => {
      if (secret !== 'whsec_connect') throw new Error('No signatures found matching the expected signature');
      return { type: 'account.updated', created: 1, data: { object: { id: 'acct_1', metadata: { userId: TRADIE } } } };
    });

    const res = await payments.handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: '{}' });

    expect(res.statusCode).toBe(200);
    expect(mockStripe.webhooks.constructEvent.mock.calls.map(([, , secret]) => secret)).toEqual(['whsec_platform', 'whsec_connect']);
  });

  test('a signature that matches neither secret is rejected without touching data', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad signature'); });

    const res = await payments.handleWebhook({ headers: { 'Stripe-Signature': 'forged' }, body: '{}' });

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test('a database failure returns 500 so Stripe retries the event', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_1' }) });
    mockDb.update.mockReturnValue(fail(new Error('ProvisionedThroughputExceeded')));

    const res = await webhook('payment_intent.succeeded', {
      id: 'pi_1', amount: 21383, currency: 'aud', metadata: { bookingId: 'b1' },
    });

    expect(res.statusCode).toBe(500);
  });

  test('if the Stripe secret can\'t be loaded, the next request tries again', async () => {
    await jest.isolateModulesAsync(async () => {
      const fresh = require('../lib/lambdas/payments');
      mockSecrets.getSecretValue
        .mockReturnValueOnce(fail(new Error('ResourceNotFoundException')))
        .mockReturnValueOnce(ok({ SecretString: JSON.stringify(SECRET) }));
      mockStripe.webhooks.constructEvent.mockReturnValue({ type: 'charge.refunded', data: { object: {} } });
      const event = { headers: { 'Stripe-Signature': 'sig' }, body: '{}' };

      const first = await fresh.handleWebhook(event);
      const second = await fresh.handleWebhook(event);

      expect(first.statusCode).toBe(500);
      expect(second.statusCode).toBe(200);
    });
  });

  test('a secret without secretKey is treated as misconfigured', async () => {
    await jest.isolateModulesAsync(async () => {
      const fresh = require('../lib/lambdas/payments');
      mockSecrets.getSecretValue.mockReturnValue(ok({ SecretString: JSON.stringify({ webhookSecret: 'whsec_x' }) }));

      const res = await fresh.handleWebhook({ headers: { 'Stripe-Signature': 'sig' }, body: '{}' });

      expect(res.statusCode).toBe(500);
      expect(mockStripe.webhooks.constructEvent).not.toHaveBeenCalled();
    });
  });
});

describe('webhook payment events', () => {
  test('succeeded without booking metadata is ignored', async () => {
    const res = await webhook('payment_intent.succeeded', { id: 'pi_x', amount: 100, currency: 'aud', metadata: {} });

    expect(res.statusCode).toBe(200);
    expect(mockDb.get).not.toHaveBeenCalled();
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test('succeeded for an intent the booking has since replaced writes nothing', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_new', paymentStatus: 'payment_pending' }) });
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));

    const res = await webhook('payment_intent.succeeded', {
      id: 'pi_old', amount: 21383, currency: 'aud', metadata: { bookingId: 'b1' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test('succeeded for a deleted booking returns 500 so it is retried and noticed', async () => {
    mockTables({});

    const res = await webhook('payment_intent.succeeded', {
      id: 'pi_1', amount: 21383, currency: 'aud', metadata: { bookingId: 'gone' },
    });

    expect(res.statusCode).toBe(500);
  });

  test('canceled marks the booking cancelled only for its current, unpaid intent', async () => {
    const res = await webhook('payment_intent.canceled', { id: 'pi_1', metadata: { bookingId: 'b1' } });

    const params = mockDb.update.mock.calls[0][0];
    expect(res.statusCode).toBe(200);
    expect(params.ExpressionAttributeValues).toMatchObject({ ':ps': 'payment_cancelled', ':pi': 'pi_1' });
    expect(params.ConditionExpression).toBe('stripePaymentIntentId = :pi AND paymentStatus <> :paid');
  });

  test('failure events without booking metadata are ignored', async () => {
    const res = await webhook('payment_intent.payment_failed', { id: 'pi_1', metadata: {} });

    expect(res.statusCode).toBe(200);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('webhook account and subscription events', () => {
  test('account.updated without a HomeLink user is ignored', async () => {
    const res = await webhook('account.updated', { id: 'acct_1', metadata: {} });

    expect(res.statusCode).toBe(200);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('account.updated only applies to the account saved on that user', async () => {
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));

    const res = await webhook('account.updated', {
      id: 'acct_attacker', charges_enabled: true, payouts_enabled: true, metadata: { userId: TRADIE },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.update.mock.calls[0][0]).toMatchObject({
      ConditionExpression: 'stripeAccountId = :aid',
      ExpressionAttributeValues: expect.objectContaining({ ':aid': 'acct_attacker' }),
    });
  });

  test('subscription events without a HomeLink user are ignored', async () => {
    const res = await webhook('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: {} });

    expect(res.statusCode).toBe(200);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('an expanded customer object is matched by its id', async () => {
    await webhook('customer.subscription.created', {
      id: 'sub_1', customer: { id: 'cus_1' }, status: 'trialing', metadata: { userId: TRADIE },
    });

    expect(mockDb.update.mock.calls[0][0].ExpressionAttributeValues).toMatchObject({ ':cid': 'cus_1', ':pro': true });
  });
});

describe('payout status', () => {
  test('a tradie with no payout account is reported as not onboarded, without calling Stripe', async () => {
    mockTables({ users: tradie() });

    const res = await payments.connectStatus(apiEvent(TRADIE));

    expect(bodyOf(res)).toEqual({ onboarded: false, chargesEnabled: false, payoutsEnabled: false });
    expect(mockStripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  test('refreshes the account from Stripe and saves it', async () => {
    mockTables({ users: tradie({ stripeAccountId: 'acct_1' }) });
    mockStripe.accounts.retrieve.mockResolvedValue({
      id: 'acct_1', details_submitted: true, charges_enabled: true, payouts_enabled: false,
      requirements: { currently_due: ['external_account'] },
    });

    const res = await payments.connectStatus(apiEvent(TRADIE));

    expect(bodyOf(res)).toEqual({
      onboarded: true, chargesEnabled: true, payoutsEnabled: false, requirementsDue: ['external_account'],
    });
    expect(mockDb.update.mock.calls[0][0].ExpressionAttributeValues).toMatchObject({ ':ce': true, ':pe': false });
  });

  test('homeowners have no payout status', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner' } });

    const res = await payments.connectStatus(apiEvent(HOMEOWNER));

    expect(res.statusCode).toBe(403);
  });

  test('onboarding again reuses the existing account and returns a fresh link', async () => {
    mockTables({ users: tradie({ stripeAccountId: 'acct_1' }) });
    mockStripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/again', expires_at: 2 });

    const res = await payments.connectOnboard(apiEvent(TRADIE));

    expect(mockStripe.accounts.create).not.toHaveBeenCalled();
    expect(mockStripe.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({
      account: 'acct_1',
      return_url: 'https://app.example.com/payouts/setup?complete=true',
      refresh_url: 'https://app.example.com/payouts/setup?refresh=true',
    }));
    expect(bodyOf(res).onboardingUrl).toBe('https://connect.stripe.com/again');
  });

  test('a concurrent onboarding request that saved the account first is not an error', async () => {
    mockTables({ users: tradie() });
    mockStripe.accounts.create.mockResolvedValue({ id: 'acct_same' });
    mockStripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/x' });
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));

    const res = await payments.connectOnboard(apiEvent(TRADIE));

    expect(res.statusCode).toBe(200);
    expect(mockStripe.accounts.create.mock.calls[0][1]).toEqual({ idempotencyKey: `connect-account-${TRADIE}` });
  });
});

describe('Pro billing', () => {
  test('the billing portal opens for the tradie\'s own customer', async () => {
    mockTables({ users: tradie({ stripeCustomerId: 'cus_1' }) });
    mockStripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p' });

    const res = await payments.proBillingPortal(apiEvent(TRADIE));

    expect(bodyOf(res)).toEqual({ portalUrl: 'https://billing.stripe.com/p' });
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1', return_url: 'https://app.example.com/pro',
    });
  });

  test('no portal before the tradie has ever subscribed', async () => {
    mockTables({ users: tradie() });

    const res = await payments.proBillingPortal(apiEvent(TRADIE));

    expect(res.statusCode).toBe(404);
  });

  test('homeowners have no Pro billing', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner' } });

    expect((await payments.proBillingPortal(apiEvent(HOMEOWNER))).statusCode).toBe(403);
    expect((await payments.proStatus(apiEvent(HOMEOWNER))).statusCode).toBe(403);
  });

  test('subscribing again reuses the tradie\'s Stripe customer', async () => {
    mockTables({ users: tradie({ stripeCustomerId: 'cus_1' }) });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });

    await payments.subscribePro(apiEvent(TRADIE));

    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_1');
  });

  test('unauthenticated calls are refused', async () => {
    const anonymous = { requestContext: {} };

    for (const handler of [payments.subscribePro, payments.proBillingPortal, payments.proStatus, payments.connectOnboard, payments.connectStatus]) {
      expect((await handler(anonymous)).statusCode).toBe(401);
    }
  });
});

describe('payment lookups and checkout guards', () => {
  test('older payment records without a tradieId fall back to the booking for access', async () => {
    mockTables({
      payments: { paymentId: 'pay_1', bookingId: 'b1', homeownerId: HOMEOWNER },
      bookings: booking(),
    });

    const tradieRes = await payments.getPayment(apiEvent(TRADIE, { pathParameters: { paymentId: 'pay_1' } }));
    const strangerRes = await payments.getPayment(apiEvent('stranger', { pathParameters: { paymentId: 'pay_1' } }));

    expect(tradieRes.statusCode).toBe(200);
    expect(strangerRes.statusCode).toBe(403);
  });

  test('a booking\'s payment lookup returns the most recent record', async () => {
    mockTables({ bookings: booking() });
    mockDb.query.mockReturnValue(ok({ Items: [{ paymentId: 'pay_new' }, { paymentId: 'pay_old' }] }));

    const res = await payments.getBookingPayment(apiEvent(HOMEOWNER, { pathParameters: { bookingId: 'b1' } }));

    expect(bodyOf(res).paymentId).toBe('pay_new');
    expect(mockDb.query.mock.calls[0][0]).toMatchObject({ IndexName: 'BookingIdIndex', ScanIndexForward: false });
  });

  test('a booking with no payment yet is a 404', async () => {
    mockTables({ bookings: booking() });
    mockDb.query.mockReturnValue(ok({ Items: [] }));

    const res = await payments.getBookingPayment(apiEvent(HOMEOWNER, { pathParameters: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(404);
  });

  test('confirming a payment that hasn\'t succeeded records nothing', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_1' }) });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', status: 'requires_action', metadata: { bookingId: 'b1' } });

    const res = await payments.confirmPayment(apiEvent(HOMEOWNER, { body: { bookingId: 'b1', paymentIntentId: 'pi_1' } }));

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test.each([['succeeded'], ['processing']])('no new charge while the existing one is %s', async (status) => {
    mockTables({
      bookings: booking({ stripePaymentIntentId: 'pi_1' }),
      users: tradie({ stripeAccountId: 'acct_1', stripeChargesEnabled: true }),
    });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', status });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(409);
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('a paid booking cannot be charged again', async () => {
    mockTables({ bookings: booking({ paymentStatus: 'paid' }), users: tradie() });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(409);
  });

  test('only the booking\'s homeowner can pay for it', async () => {
    mockTables({ bookings: booking(), users: tradie() });

    const res = await payments.createPaymentIntent(apiEvent(TRADIE, { body: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(403);
  });
});
