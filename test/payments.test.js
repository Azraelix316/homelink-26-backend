// Unit tests for the payments Lambda, with DynamoDB, Secrets Manager and Stripe mocked

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

const apiEvent = (userId, { body, pathParameters } = {}) => ({
  requestContext: { authorizer: { claims: { sub: userId } } },
  body: body ? JSON.stringify(body) : null,
  pathParameters,
});
const bodyOf = res => JSON.parse(res.body);

const booking = (overrides = {}) => ({
  bookingId: 'b1',
  homeownerId: HOMEOWNER,
  tradieId: TRADIE,
  startTime: '09:00',
  endTime: '11:00',
  status: 'accepted',
  ...overrides,
});
const tradie = (overrides = {}) => ({
  userId: TRADIE,
  role: 'tradie',
  hourlyRate: 100,
  stripeAccountId: 'acct_123',
  stripeChargesEnabled: true,
  ...overrides,
});

// Route DynamoDB gets by table name
function mockTables(tables) {
  mockDb.get.mockImplementation(({ TableName }) => ok({ Item: tables[TableName] }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSecrets.getSecretValue.mockReturnValue(ok({
    SecretString: JSON.stringify({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }),
  }));
  mockDb.put.mockReturnValue(ok({}));
  mockDb.update.mockReturnValue(ok({}));
});

describe('createPaymentIntent', () => {
  test('charges the server-side price, ignoring any client amount', async () => {
    mockTables({ bookings: booking(), users: tradie() });
    mockStripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_1', client_secret: 'secret', amount: 21383, currency: 'aud', status: 'requires_payment_method',
    });

    const res = await payments.createPaymentIntent(
      apiEvent(HOMEOWNER, { body: { bookingId: 'b1', amount: 1, currency: 'usd' } })
    );

    expect(res.statusCode).toBe(200);
    // 2h x $100 = $200 + 5% fee ($10), grossed up for 1.65% + $0.30 card fee = $213.83
    // HomeLink collects $213.83 - $180 tradie share = $33.83
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 21383,
        currency: 'aud',
        application_fee_amount: 3383,
        transfer_data: { destination: 'acct_123' },
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('booking-b1') })
    );
  });

  test('HomeLink Pro tradies pay no commission', async () => {
    mockTables({ bookings: booking(), users: tradie({ hasHomeinkPro: true }) });
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1', amount: 21000, currency: 'aud' });

    await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    // No commission: HomeLink collects only the $10 service fee + $3.83 card markup
    expect(mockStripe.paymentIntents.create.mock.calls[0][0].application_fee_amount).toBe(1383);
  });

  test('rejects bookings the tradie has not accepted', async () => {
    mockTables({ bookings: booking({ status: 'pending' }), users: tradie() });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(400);
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('rejects payment until the tradie has finished payout setup', async () => {
    mockTables({ bookings: booking(), users: tradie({ stripeChargesEnabled: false }) });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(409);
  });

  test('reuses an unchanged, still-payable intent instead of creating another', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_old' }), users: tradie() });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_old', client_secret: 'secret', amount: 21383, application_fee_amount: 3383,
      transfer_data: { destination: 'acct_123' }, currency: 'aud', status: 'requires_payment_method',
    });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(bodyOf(res).paymentIntentId).toBe('pi_old');
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('cancels a stale intent when the price has changed', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_old' }), users: tradie({ hourlyRate: 120 }) });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_old', amount: 21383, application_fee_amount: 3383,
      transfer_data: { destination: 'acct_123' }, status: 'requires_payment_method',
    });
    mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_new', amount: 25200, currency: 'aud' });

    const res = await payments.createPaymentIntent(apiEvent(HOMEOWNER, { body: { bookingId: 'b1' } }));

    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_old');
    expect(bodyOf(res).paymentIntentId).toBe('pi_new');
  });
});

describe('confirmPayment', () => {
  const succeededIntent = (overrides = {}) => ({
    id: 'pi_1', status: 'succeeded', amount: 21000, application_fee_amount: 3000,
    currency: 'aud', metadata: { bookingId: 'b1' }, ...overrides,
  });

  test('rejects an intent that belongs to a different booking', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_1' }) });
    mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent({ metadata: { bookingId: 'other' } }));

    const res = await payments.confirmPayment(
      apiEvent(HOMEOWNER, { body: { bookingId: 'b1', paymentIntentId: 'pi_1' } })
    );

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('rejects an intent that is not the booking\'s current one', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_current' }) });

    const res = await payments.confirmPayment(
      apiEvent(HOMEOWNER, { body: { bookingId: 'b1', paymentIntentId: 'pi_other' } })
    );

    expect(res.statusCode).toBe(400);
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('records the payment and notifies the tradie once', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_1' }) });
    mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent());

    const res = await payments.confirmPayment(
      apiEvent(HOMEOWNER, { body: { bookingId: 'b1', paymentIntentId: 'pi_1' } })
    );

    expect(res.statusCode).toBe(200);
    const tablesWritten = mockDb.put.mock.calls.map(([params]) => params.TableName);
    expect(tablesWritten).toEqual(['payments', 'notifications']);
    expect(mockDb.put.mock.calls[0][0].Item).toMatchObject({ tradieId: TRADIE, amount: 210, applicationFee: 30 });
  });

  test('a repeat confirmation does not notify the tradie again', async () => {
    const paid = booking({ stripePaymentIntentId: 'pi_1', paymentStatus: 'paid', paymentId: 'pay_1' });
    mockTables({ bookings: paid });
    mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));
    mockDb.put.mockImplementation(({ TableName }) =>
      TableName === 'payments' ? fail(conditionalCheckFailed()) : ok({})
    );

    const res = await payments.confirmPayment(
      apiEvent(HOMEOWNER, { body: { bookingId: 'b1', paymentIntentId: 'pi_1' } })
    );

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).paymentId).toBe('pay_1');
    expect(mockDb.put.mock.calls.map(([p]) => p.TableName)).not.toContain('notifications');
  });
});

describe('payment lookups', () => {
  test('getPayment refuses users who are not on the booking', async () => {
    mockTables({ payments: { paymentId: 'pay_1', bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE } });

    const res = await payments.getPayment(apiEvent('stranger', { pathParameters: { paymentId: 'pay_1' } }));

    expect(res.statusCode).toBe(403);
  });

  test('getPayment allows the tradie on the booking', async () => {
    mockTables({ payments: { paymentId: 'pay_1', bookingId: 'b1', homeownerId: HOMEOWNER, tradieId: TRADIE } });

    const res = await payments.getPayment(apiEvent(TRADIE, { pathParameters: { paymentId: 'pay_1' } }));

    expect(res.statusCode).toBe(200);
  });

  test('getBookingPayment refuses users who are not on the booking', async () => {
    mockTables({ bookings: booking() });

    const res = await payments.getBookingPayment(apiEvent('stranger', { pathParameters: { bookingId: 'b1' } }));

    expect(res.statusCode).toBe(403);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe('handleWebhook', () => {
  const webhookEvent = headers => ({ headers, body: '{"raw":true}', isBase64Encoded: false });

  test('reads the Stripe-Signature header regardless of case', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({ type: 'charge.refunded', data: { object: {} } });

    const res = await payments.handleWebhook(webhookEvent({ 'Stripe-Signature': 't=1,v1=abc' }));

    expect(res.statusCode).toBe(200);
    expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith('{"raw":true}', 't=1,v1=abc', 'whsec_x');
  });

  test('rejects a bad signature', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });

    const res = await payments.handleWebhook(webhookEvent({ 'stripe-signature': 'nope' }));

    expect(res.statusCode).toBe(400);
  });

  test('payment_intent.succeeded writes the payment record', async () => {
    mockTables({ bookings: booking({ stripePaymentIntentId: 'pi_1' }) });
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', amount: 21000, currency: 'aud', metadata: { bookingId: 'b1' } } },
    });

    const res = await payments.handleWebhook(webhookEvent({ 'Stripe-Signature': 'sig' }));

    expect(res.statusCode).toBe(200);
    expect(mockDb.put.mock.calls.map(([p]) => p.TableName)).toContain('payments');
  });

  test('a late failure event does not un-pay a paid booking', async () => {
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1', metadata: { bookingId: 'b1' } } },
    });

    const res = await payments.handleWebhook(webhookEvent({ 'Stripe-Signature': 'sig' }));

    expect(res.statusCode).toBe(200);
    expect(mockDb.update.mock.calls[0][0].ConditionExpression).toContain('paymentStatus <> :paid');
  });

  test('account.updated saves the tradie\'s payout status', async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'account.updated',
      data: { object: { id: 'acct_123', charges_enabled: true, payouts_enabled: true, metadata: { userId: TRADIE } } },
    });

    await payments.handleWebhook(webhookEvent({ 'Stripe-Signature': 'sig' }));

    expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'users',
      Key: { userId: TRADIE },
      ExpressionAttributeValues: expect.objectContaining({ ':ce': true, ':aid': 'acct_123' }),
    }));
  });
});

describe('connectOnboard', () => {
  test('creates an Express account for a new tradie and returns an onboarding link', async () => {
    mockTables({ users: tradie({ stripeAccountId: undefined, email: 't@example.com' }) });
    mockStripe.accounts.create.mockResolvedValue({ id: 'acct_new' });
    mockStripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/x', expires_at: 1 });

    const res = await payments.connectOnboard(apiEvent(TRADIE));

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).onboardingUrl).toBe('https://connect.stripe.com/x');
    expect(mockStripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'express', country: 'AU', metadata: { userId: TRADIE } }),
      expect.anything()
    );
  });

  test('homeowners cannot set up payouts', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner' } });

    const res = await payments.connectOnboard(apiEvent(HOMEOWNER));

    expect(res.statusCode).toBe(403);
  });
});

describe('HomeLink Pro', () => {
  const subscription = (overrides = {}) => ({
    id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
    current_period_end: 1800000000, metadata: { userId: TRADIE }, ...overrides,
  });
  const subscriptionEvent = (type, sub, created = 100) => {
    mockStripe.webhooks.constructEvent.mockReturnValue({ type, created, data: { object: sub } });
    return payments.handleWebhook({ headers: { 'Stripe-Signature': 'sig' }, body: '{}' });
  };

  test('subscribe creates a customer and a US$200/month checkout session', async () => {
    mockTables({ users: tradie({ email: 't@example.com' }) });
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/x', expires_at: 1 });

    const res = await payments.subscribePro(apiEvent(TRADIE));

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).checkoutUrl).toBe('https://checkout.stripe.com/x');
    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_new',
      subscription_data: { metadata: { userId: TRADIE } },
    });
    expect(params.line_items[0].price_data).toMatchObject({
      currency: 'usd', unit_amount: 20000, recurring: { interval: 'month' },
    });
  });

  test('homeowners cannot subscribe', async () => {
    mockTables({ users: { userId: HOMEOWNER, role: 'homeowner' } });

    const res = await payments.subscribePro(apiEvent(HOMEOWNER));

    expect(res.statusCode).toBe(403);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('existing Pro members are not charged twice', async () => {
    mockTables({ users: tradie({ hasHomeinkPro: true }) });

    const res = await payments.subscribePro(apiEvent(TRADIE));

    expect(res.statusCode).toBe(409);
  });

  test('an active subscription turns Pro on for the matching customer only', async () => {
    await subscriptionEvent('customer.subscription.created', subscription(), 100);

    const params = mockDb.update.mock.calls[0][0];
    expect(params).toMatchObject({ TableName: 'users', Key: { userId: TRADIE } });
    expect(params.ExpressionAttributeValues).toMatchObject({ ':pro': true, ':cid': 'cus_1', ':at': 100 });
    expect(params.ConditionExpression).toContain('stripeCustomerId = :cid');
    expect(params.ConditionExpression).toContain('proEventAt <= :at');
  });

  test('a cancelled or unpaid subscription turns Pro off', async () => {
    await subscriptionEvent('customer.subscription.deleted', subscription({ status: 'canceled' }));
    await subscriptionEvent('customer.subscription.updated', subscription({ status: 'past_due' }));

    expect(mockDb.update.mock.calls.map(([p]) => p.ExpressionAttributeValues[':pro'])).toEqual([false, false]);
  });

  test('stale or mismatched subscription events are ignored', async () => {
    mockDb.update.mockReturnValue(fail(conditionalCheckFailed()));

    const res = await subscriptionEvent('customer.subscription.updated', subscription());

    expect(res.statusCode).toBe(200);
  });

  test('status reports the stored membership', async () => {
    mockTables({ users: tradie({ hasHomeinkPro: true, proStatus: 'active', proCurrentPeriodEnd: 1800000000 }) });

    const res = await payments.proStatus(apiEvent(TRADIE));

    expect(bodyOf(res)).toEqual({ hasPro: true, status: 'active', currentPeriodEnd: 1800000000, cancelAtPeriodEnd: false });
  });
});
