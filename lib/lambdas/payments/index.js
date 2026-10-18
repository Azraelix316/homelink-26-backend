const AWS = require('aws-sdk');
const Stripe = require('stripe');
const { response, errorResponse, getUserId, getBody, getPathParam, now, generateId, withCors } = require('./utils');
const { calculatePricing, timeToMinutes, BOOKING_STATUSES } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const secretsManager = new AWS.SecretsManager({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const CURRENCY = (process.env.STRIPE_CURRENCY || 'aud').toLowerCase();

// Booking statuses that can be paid for
const PAYABLE_STATUSES = [BOOKING_STATUSES.ACCEPTED, BOOKING_STATUSES.COMPLETED];

// PaymentIntent statuses that can still be completed by the customer
const REUSABLE_INTENT_STATUSES = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

/**
 * Load Stripe keys from Secrets Manager once per container
 */
let stripeConfigPromise;
function getStripeConfig() {
  if (!stripeConfigPromise) {
    stripeConfigPromise = secretsManager
      .getSecretValue({ SecretId: process.env.STRIPE_SECRET_ID })
      .promise()
      .then(result => {
        const secret = JSON.parse(result.SecretString);
        if (!secret.secretKey) {
          throw new Error('Stripe secret is missing secretKey');
        }
        return { stripe: Stripe(secret.secretKey), ...secret };
      })
      .catch(error => {
        stripeConfigPromise = undefined; // retry on next invocation
        throw error;
      });
  }
  return stripeConfigPromise;
}

/**
 * A page in the frontend. It uses hash routing (/#/pro), so links Stripe
 * sends people back to must carry the route after the #.
 */
function appUrl(route) {
  return `${process.env.FRONTEND_URL.replace(/\/$/, '')}/#${route}`;
}

async function getStripe() {
  return (await getStripeConfig()).stripe;
}

/**
 * Convert a dollar amount to cents
 */
function toCents(amount) {
  return Math.round(amount * 100);
}

function isConditionalCheckFailed(error) {
  return error.code === 'ConditionalCheckFailedException';
}

/**
 * Case-insensitive header lookup (API Gateway REST passes headers as sent)
 */
function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

async function getBooking(bookingId) {
  const result = await dynamodb.get({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
  }).promise();
  return result.Item;
}

function isBookingParticipant(booking, userId) {
  return booking.homeownerId === userId || booking.tradieId === userId;
}

/**
 * Work out what the homeowner owes for a booking, from the tradie's rate
 * and the booking duration. Never trust an amount sent by the client.
 */
function getBookingCharge(booking, tradie) {
  const hours = (timeToMinutes(booking.endTime) - timeToMinutes(booking.startTime)) / 60;
  if (!(hours > 0)) {
    throw new Error(`Invalid booking times for booking ${booking.bookingId}`);
  }
  if (!(tradie.hourlyRate > 0)) {
    throw new Error(`Tradie ${tradie.userId} has no hourly rate`);
  }

  const pricing = calculatePricing(tradie.hourlyRate, hours, tradie.hasHomeinkPro || false);
  const amountCents = toCents(pricing.homeownerPays);
  // HomeLink collects the service fee, the tradie commission and the card
  // processing markup; Stripe's card fee is then paid out of that
  const applicationFeeCents = toCents(pricing.applicationFee);

  return { pricing, amountCents, applicationFeeCents };
}

/**
 * Mark a booking as paid and write the payment record.
 * Safe to call more than once for the same PaymentIntent (from both the
 * confirm endpoint and the webhook): only the first call notifies the tradie.
 * Returns null if the intent is no longer the booking's current intent.
 */
async function recordSuccessfulPayment(paymentIntent) {
  const { bookingId } = paymentIntent.metadata || {};
  if (!bookingId) {
    throw new Error(`PaymentIntent ${paymentIntent.id} is missing bookingId metadata`);
  }

  const booking = await getBooking(bookingId);
  if (!booking) {
    throw new Error(`Booking ${bookingId} not found for PaymentIntent ${paymentIntent.id}`);
  }

  let paymentId = booking.paymentId || generateId();
  let isFirstRecord = true;

  try {
    await dynamodb.update({
      TableName: process.env.BOOKINGS_TABLE,
      Key: { bookingId },
      UpdateExpression: 'SET paymentStatus = :ps, paymentId = :pid, paymentAmount = :amt, paymentDate = :pd, updatedAt = :ua',
      ConditionExpression: 'stripePaymentIntentId = :pi AND (attribute_not_exists(paymentStatus) OR paymentStatus <> :ps)',
      ExpressionAttributeValues: {
        ':ps': 'paid',
        ':pid': paymentId,
        ':amt': paymentIntent.amount / 100,
        ':pd': now(),
        ':ua': now(),
        ':pi': paymentIntent.id,
      },
    }).promise();
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;

    // Either already recorded, or this intent no longer belongs to the booking
    const current = await getBooking(bookingId);
    if (current.paymentStatus !== 'paid' || current.stripePaymentIntentId !== paymentIntent.id) {
      console.warn(`PaymentIntent ${paymentIntent.id} does not match booking ${bookingId}`);
      return null;
    }
    paymentId = current.paymentId;
    isFirstRecord = false;
  }

  const payment = {
    paymentId,
    bookingId,
    homeownerId: booking.homeownerId,
    tradieId: booking.tradieId,
    stripePaymentIntentId: paymentIntent.id,
    amount: paymentIntent.amount / 100,
    applicationFee: (paymentIntent.application_fee_amount || 0) / 100,
    currency: paymentIntent.currency.toUpperCase(),
    status: 'completed',
    createdAt: now(),
    updatedAt: now(),
  };

  // Write the record if it isn't there yet (covers a crash between the two writes)
  try {
    await dynamodb.put({
      TableName: process.env.PAYMENTS_TABLE,
      Item: payment,
      ConditionExpression: 'attribute_not_exists(paymentId)',
    }).promise();
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
  }

  if (isFirstRecord) {
    await dynamodb.put({
      TableName: process.env.NOTIFICATIONS_TABLE,
      Item: {
        notificationId: generateId(),
        userId: booking.tradieId,
        type: 'payment_received',
        message: `Payment received for booking ${bookingId}`,
        bookingId,
        read: false,
        createdAt: now(),
        updatedAt: now(),
      },
    }).promise();
  }

  return payment;
}

/**
 * POST /payments/create-payment-intent
 * Create (or reuse) the Stripe PaymentIntent for a booking.
 * The amount is calculated server-side from the tradie's rate.
 * Body: { bookingId }
 */
async function createPaymentIntent(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const { bookingId } = getBody(event);
    if (!bookingId) {
      return errorResponse(400, 'Missing required field: bookingId');
    }

    const booking = await getBooking(bookingId);
    if (!booking) {
      return errorResponse(404, 'Booking not found');
    }

    if (booking.homeownerId !== userId) {
      return errorResponse(403, 'Not authorized to pay for this booking');
    }

    if (!PAYABLE_STATUSES.includes(booking.status)) {
      return errorResponse(400, 'Can only pay for accepted or completed bookings');
    }

    if (booking.paymentStatus === 'paid') {
      return errorResponse(409, 'Booking has already been paid');
    }

    const tradieResult = await dynamodb.get({
      TableName: process.env.USERS_TABLE,
      Key: { userId: booking.tradieId },
    }).promise();
    const tradie = tradieResult.Item;
    if (!tradie) {
      return errorResponse(404, 'Tradie not found');
    }

    if (!tradie.stripeAccountId || !tradie.stripeChargesEnabled) {
      return errorResponse(409, 'Tradie has not finished setting up payouts yet');
    }

    const { amountCents, applicationFeeCents } = getBookingCharge(booking, tradie);
    const stripe = await getStripe();

    // Reuse the booking's existing intent if it's still payable and unchanged
    let paymentIntent;
    if (booking.stripePaymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId);

      if (existing.status === 'succeeded' || existing.status === 'processing') {
        return errorResponse(409, `Payment for this booking is already ${existing.status}`);
      }

      const unchanged = existing.amount === amountCents
        && existing.application_fee_amount === applicationFeeCents
        && existing.transfer_data?.destination === tradie.stripeAccountId;

      if (REUSABLE_INTENT_STATUSES.includes(existing.status) && unchanged) {
        paymentIntent = existing;
      } else if (existing.status !== 'canceled') {
        await stripe.paymentIntents.cancel(existing.id);
      }
    }

    if (!paymentIntent) {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: CURRENCY,
        application_fee_amount: applicationFeeCents,
        transfer_data: { destination: tradie.stripeAccountId },
        automatic_payment_methods: { enabled: true },
        metadata: {
          bookingId,
          homeownerId: userId,
          tradieId: booking.tradieId,
        },
        description: `Payment for booking ${bookingId}`,
      }, {
        // Concurrent requests for the same booking get the same intent
        idempotencyKey: `booking-${bookingId}-${booking.stripePaymentIntentId || 'first'}-${amountCents}-${applicationFeeCents}`,
      });

      await dynamodb.update({
        TableName: process.env.BOOKINGS_TABLE,
        Key: { bookingId },
        UpdateExpression: 'SET stripePaymentIntentId = :id, paymentStatus = :status, updatedAt = :ua',
        ExpressionAttributeValues: {
          ':id': paymentIntent.id,
          ':status': 'payment_pending',
          ':ua': now(),
        },
      }).promise();
    }

    return response(200, {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
    });
  } catch (error) {
    console.error('Create payment intent error:', error);
    return errorResponse(500, 'Failed to create payment intent');
  }
}

/**
 * POST /payments/confirm-payment
 * Confirm Stripe payment and update booking status
 * Body: { bookingId, paymentIntentId }
 */
async function confirmPayment(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const { bookingId, paymentIntentId } = getBody(event);
    if (!bookingId || !paymentIntentId) {
      return errorResponse(400, 'Missing required fields: bookingId, paymentIntentId');
    }

    const booking = await getBooking(bookingId);
    if (!booking) {
      return errorResponse(404, 'Booking not found');
    }

    if (booking.homeownerId !== userId) {
      return errorResponse(403, 'Not authorized to confirm payment for this booking');
    }

    if (booking.stripePaymentIntentId !== paymentIntentId) {
      return errorResponse(400, 'Payment does not belong to this booking');
    }

    const stripe = await getStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.metadata?.bookingId !== bookingId) {
      return errorResponse(400, 'Payment does not belong to this booking');
    }

    if (paymentIntent.status !== 'succeeded') {
      return errorResponse(400, `Payment not successful. Status: ${paymentIntent.status}`);
    }

    const payment = await recordSuccessfulPayment(paymentIntent);
    if (!payment) {
      return errorResponse(409, 'Payment does not match the booking\'s current payment');
    }

    return response(200, {
      paymentId: payment.paymentId,
      bookingId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      message: 'Payment confirmed successfully',
    });
  } catch (error) {
    console.error('Confirm payment error:', error);
    return errorResponse(500, 'Failed to confirm payment');
  }
}

/**
 * GET /payments/{paymentId}
 * Get payment details (homeowner or tradie on the booking only)
 */
async function getPayment(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const paymentId = getPathParam(event, 'paymentId');
    if (!paymentId) {
      return errorResponse(400, 'paymentId required');
    }

    const result = await dynamodb.get({
      TableName: process.env.PAYMENTS_TABLE,
      Key: { paymentId },
    }).promise();

    const payment = result.Item;
    if (!payment) {
      return errorResponse(404, 'Payment not found');
    }

    // Older records have no tradieId, so fall back to the booking
    let allowed = payment.homeownerId === userId || payment.tradieId === userId;
    if (!allowed && !payment.tradieId) {
      const booking = await getBooking(payment.bookingId);
      allowed = booking && isBookingParticipant(booking, userId);
    }

    if (!allowed) {
      return errorResponse(403, 'Not authorized to view this payment');
    }

    return response(200, payment);
  } catch (error) {
    console.error('Get payment error:', error);
    return errorResponse(500, 'Failed to fetch payment');
  }
}

/**
 * GET /payments/booking/{bookingId}
 * Get payment for a specific booking (homeowner or tradie on the booking only)
 */
async function getBookingPayment(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }

    const booking = await getBooking(bookingId);
    if (!booking) {
      return errorResponse(404, 'Booking not found');
    }

    if (!isBookingParticipant(booking, userId)) {
      return errorResponse(403, 'Not authorized to view payments for this booking');
    }

    const result = await dynamodb.query({
      TableName: process.env.PAYMENTS_TABLE,
      IndexName: 'BookingIdIndex',
      KeyConditionExpression: 'bookingId = :bid',
      ExpressionAttributeValues: {
        ':bid': bookingId,
      },
      ScanIndexForward: false, // most recent first
    }).promise();

    if (result.Items.length === 0) {
      return errorResponse(404, 'No payment found for this booking');
    }

    return response(200, result.Items[0]);
  } catch (error) {
    console.error('Get booking payment error:', error);
    return errorResponse(500, 'Failed to fetch booking payment');
  }
}

/**
 * Load the user's record if they're a tradie, otherwise null
 */
async function getTradieUser(userId) {
  const result = await dynamodb.get({
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  }).promise();
  return result.Item && result.Item.role === 'tradie' ? result.Item : null;
}

/**
 * Save a Connect account's payout readiness on the tradie's user record
 */
async function saveConnectStatus(userId, account) {
  await dynamodb.update({
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    UpdateExpression: 'SET stripeChargesEnabled = :ce, stripePayoutsEnabled = :pe, updatedAt = :ua',
    ConditionExpression: 'stripeAccountId = :aid',
    ExpressionAttributeValues: {
      ':ce': !!account.charges_enabled,
      ':pe': !!account.payouts_enabled,
      ':ua': now(),
      ':aid': account.id,
    },
  }).promise();
}

/**
 * POST /payments/connect/onboard
 * Create the tradie's Stripe Connect Express account (if needed) and return
 * an onboarding link. Payments go straight to this account, minus HomeLink's fee.
 */
async function connectOnboard(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const tradie = await getTradieUser(userId);
    if (!tradie) {
      return errorResponse(403, 'Only tradies can set up payouts');
    }

    const stripe = await getStripe();
    let accountId = tradie.stripeAccountId;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'AU',
        email: tradie.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { userId },
      }, {
        idempotencyKey: `connect-account-${userId}`,
      });
      accountId = account.id;

      // A concurrent request may have saved it first; the idempotency key
      // means it's the same account either way
      await dynamodb.update({
        TableName: process.env.USERS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET stripeAccountId = :aid, stripeChargesEnabled = :f, stripePayoutsEnabled = :f, updatedAt = :ua',
        ConditionExpression: 'attribute_not_exists(stripeAccountId)',
        ExpressionAttributeValues: {
          ':aid': accountId,
          ':f': false,
          ':ua': now(),
        },
      }).promise().catch(error => {
        if (!isConditionalCheckFailed(error)) throw error;
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: appUrl('/payouts/setup?refresh=true'),
      return_url: appUrl('/payouts/setup?complete=true'),
    });

    return response(200, {
      stripeAccountId: accountId,
      onboardingUrl: accountLink.url,
      expiresAt: accountLink.expires_at,
    });
  } catch (error) {
    console.error('Connect onboarding error:', error);
    return errorResponse(500, 'Failed to start payout setup');
  }
}

/**
 * GET /payments/connect/status
 * Refresh and return the tradie's Stripe Connect account status
 */
async function connectStatus(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const tradie = await getTradieUser(userId);
    if (!tradie) {
      return errorResponse(403, 'Only tradies have payout accounts');
    }

    if (!tradie.stripeAccountId) {
      return response(200, { onboarded: false, chargesEnabled: false, payoutsEnabled: false });
    }

    const stripe = await getStripe();
    const account = await stripe.accounts.retrieve(tradie.stripeAccountId);
    await saveConnectStatus(userId, account);

    return response(200, {
      onboarded: !!account.details_submitted,
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      requirementsDue: account.requirements?.currently_due || [],
    });
  } catch (error) {
    console.error('Connect status error:', error);
    return errorResponse(500, 'Failed to fetch payout status');
  }
}

/**
 * Subscription statuses that count as an active HomeLink Pro membership
 */
const PRO_ACTIVE_STATUSES = ['active', 'trialing'];

/**
 * Get or create the Stripe Customer used to bill a tradie's Pro subscription
 */
async function getOrCreateCustomer(stripe, tradie) {
  if (tradie.stripeCustomerId) {
    return tradie.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: tradie.email,
    name: tradie.name,
    metadata: { userId: tradie.userId },
  }, {
    idempotencyKey: `pro-customer-${tradie.userId}`,
  });

  // A concurrent request may have saved it first; the idempotency key
  // means it's the same customer either way
  await dynamodb.update({
    TableName: process.env.USERS_TABLE,
    Key: { userId: tradie.userId },
    UpdateExpression: 'SET stripeCustomerId = :cid, updatedAt = :ua',
    ConditionExpression: 'attribute_not_exists(stripeCustomerId)',
    ExpressionAttributeValues: { ':cid': customer.id, ':ua': now() },
  }).promise().catch(error => {
    if (!isConditionalCheckFailed(error)) throw error;
  });

  return customer.id;
}

/**
 * HomeLink Pro billing cycles. Defaults: A$149 a month or A$1,490 a year.
 * A Stripe Price ID per cycle takes precedence over the inline price
 * (and is needed for tradies to switch cycles in the billing portal).
 */
const PRO_CYCLES = {
  monthly: {
    interval: 'month',
    priceId: () => process.env.PRO_MONTHLY_PRICE_ID,
    cents: () => Number(process.env.PRO_MONTHLY_PRICE_CENTS || 14900),
  },
  annual: {
    interval: 'year',
    priceId: () => process.env.PRO_ANNUAL_PRICE_ID,
    cents: () => Number(process.env.PRO_ANNUAL_PRICE_CENTS || 149000),
  },
};

function getProLineItem(billingCycle) {
  const cycle = PRO_CYCLES[billingCycle];
  if (cycle.priceId()) {
    return { price: cycle.priceId(), quantity: 1 };
  }
  return {
    quantity: 1,
    price_data: {
      currency: (process.env.PRO_CURRENCY || 'aud').toLowerCase(),
      unit_amount: cycle.cents(),
      recurring: { interval: cycle.interval },
      product_data: {
        name: 'HomeLink Pro',
        description: 'No HomeLink commission on your jobs',
      },
    },
  };
}

/**
 * Which cycle a Stripe subscription is on, from its price's interval
 */
function getBillingCycle(subscription) {
  const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
  if (interval === 'year') return 'annual';
  if (interval === 'month') return 'monthly';
  return subscription.metadata?.billingCycle || null;
}

/**
 * POST /payments/pro/subscribe
 * Start a Stripe Checkout session for the HomeLink Pro subscription.
 * While it's active, the tradie pays no commission on their jobs.
 * Body: { billingCycle?: 'monthly' | 'annual' } (default monthly)
 */
async function subscribePro(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const tradie = await getTradieUser(userId);
    if (!tradie) {
      return errorResponse(403, 'Only tradies can subscribe to HomeLink Pro');
    }

    if (tradie.hasHomeinkPro) {
      return errorResponse(409, 'You already have HomeLink Pro');
    }

    const { billingCycle = 'monthly' } = getBody(event) || {};
    if (!Object.prototype.hasOwnProperty.call(PRO_CYCLES, billingCycle)) {
      return errorResponse(400, 'billingCycle must be monthly or annual');
    }

    const stripe = await getStripe();
    const customerId = await getOrCreateCustomer(stripe, tradie);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      line_items: [getProLineItem(billingCycle)],
      subscription_data: { metadata: { userId, billingCycle } },
      success_url: appUrl('/pro?status=success'),
      cancel_url: appUrl('/pro?status=cancelled'),
    });

    return response(200, { checkoutUrl: session.url, expiresAt: session.expires_at, billingCycle });
  } catch (error) {
    console.error('Pro subscribe error:', error);
    return errorResponse(500, 'Failed to start HomeLink Pro checkout');
  }
}

/**
 * POST /payments/pro/portal
 * Open the Stripe billing portal so a tradie can update their card or cancel Pro
 */
async function proBillingPortal(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const tradie = await getTradieUser(userId);
    if (!tradie) {
      return errorResponse(403, 'Only tradies have HomeLink Pro billing');
    }

    if (!tradie.stripeCustomerId) {
      return errorResponse(404, 'No HomeLink Pro billing account yet');
    }

    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: tradie.stripeCustomerId,
      return_url: appUrl('/pro'),
    });

    return response(200, { portalUrl: session.url });
  } catch (error) {
    console.error('Pro billing portal error:', error);
    return errorResponse(500, 'Failed to open billing portal');
  }
}

/**
 * GET /payments/pro/status
 * The tradie's HomeLink Pro membership
 */
async function proStatus(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const tradie = await getTradieUser(userId);
    if (!tradie) {
      return errorResponse(403, 'Only tradies have HomeLink Pro');
    }

    return response(200, {
      hasPro: !!tradie.hasHomeinkPro,
      status: tradie.proStatus || 'none',
      billingCycle: tradie.proBillingCycle || null,
      currentPeriodEnd: tradie.proCurrentPeriodEnd || null,
      cancelAtPeriodEnd: !!tradie.proCancelAtPeriodEnd,
    });
  } catch (error) {
    console.error('Pro status error:', error);
    return errorResponse(500, 'Failed to fetch HomeLink Pro status');
  }
}

/**
 * Keep the tradie's Pro flag in step with their Stripe subscription.
 * Events can arrive out of order, so older events never overwrite newer ones.
 */
async function handleSubscriptionChange(subscription, eventCreated) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.log(`Ignoring subscription ${subscription.id} without userId metadata`);
    return;
  }

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const hasPro = PRO_ACTIVE_STATUSES.includes(subscription.status);
  // current_period_end moved onto subscription items in newer API versions
  const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end || null;

  try {
    await dynamodb.update({
      TableName: process.env.USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET hasHomeinkPro = :pro, proStatus = :status, proSubscriptionId = :sid, proBillingCycle = :cycle, '
        + 'proCurrentPeriodEnd = :end, proCancelAtPeriodEnd = :cancel, proEventAt = :at, updatedAt = :ua',
      // Only for the customer we created for this user, and never with a stale event
      ConditionExpression: 'stripeCustomerId = :cid AND (attribute_not_exists(proEventAt) OR proEventAt <= :at)',
      ExpressionAttributeValues: {
        ':pro': hasPro,
        ':status': subscription.status,
        ':sid': subscription.id,
        ':cycle': getBillingCycle(subscription),
        ':end': periodEnd,
        ':cancel': !!subscription.cancel_at_period_end,
        ':at': eventCreated,
        ':ua': now(),
        ':cid': customerId,
      },
    }).promise();
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    console.log(`Ignoring stale or mismatched subscription event for ${subscription.id}`);
    return;
  }

  console.log(`HomeLink Pro ${hasPro ? 'active' : 'inactive'} for user ${userId} (${subscription.status})`);
}

/**
 * Verify a webhook against the platform and Connect endpoint secrets
 */
function constructWebhookEvent(stripe, config, payload, signature) {
  const secrets = [config.webhookSecret, config.connectWebhookSecret].filter(Boolean);
  let lastError = new Error('No webhook secret configured');
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * POST /payments/webhook
 * Stripe webhook handler for payment and Connect account events
 */
async function handleWebhook(event) {
  try {
    const config = await getStripeConfig();
    const signature = getHeader(event, 'stripe-signature');
    // Signature is computed over the raw body, so decode but don't parse it
    const payload = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;

    let stripeEvent;
    try {
      stripeEvent = constructWebhookEvent(config.stripe, config, payload, signature);
    } catch (error) {
      console.error('Webhook signature verification failed:', error.message);
      return errorResponse(400, 'Webhook signature verification failed');
    }

    switch (stripeEvent.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(stripeEvent.data.object);
        break;

      case 'payment_intent.payment_failed':
        await updateUnpaidStatus(stripeEvent.data.object, 'payment_failed');
        break;

      case 'payment_intent.canceled':
        await updateUnpaidStatus(stripeEvent.data.object, 'payment_cancelled');
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionChange(stripeEvent.data.object, stripeEvent.created);
        break;

      case 'account.updated':
        await handleAccountUpdated(stripeEvent.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return response(200, { received: true });
  } catch (error) {
    // Non-2xx makes Stripe retry the event
    console.error('Webhook handler error:', error);
    return errorResponse(500, 'Webhook processing failed');
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent) {
  if (!paymentIntent.metadata?.bookingId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  const payment = await recordSuccessfulPayment(paymentIntent);
  if (payment) {
    console.log(`Payment succeeded for booking: ${payment.bookingId}`);
  }
}

/**
 * Handle failed or canceled payment. Ignores events for intents that have
 * been replaced, and never overwrites a booking that's already paid.
 */
async function updateUnpaidStatus(paymentIntent, paymentStatus) {
  const { bookingId } = paymentIntent.metadata || {};

  if (!bookingId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  try {
    await dynamodb.update({
      TableName: process.env.BOOKINGS_TABLE,
      Key: { bookingId },
      UpdateExpression: 'SET paymentStatus = :ps, updatedAt = :ua',
      ConditionExpression: 'stripePaymentIntentId = :pi AND paymentStatus <> :paid',
      ExpressionAttributeValues: {
        ':ps': paymentStatus,
        ':ua': now(),
        ':pi': paymentIntent.id,
        ':paid': 'paid',
      },
    }).promise();
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    console.log(`Ignoring ${paymentStatus} for stale PaymentIntent ${paymentIntent.id}`);
    return;
  }

  console.log(`Payment ${paymentStatus} for booking: ${bookingId}`);
}

/**
 * Handle Connect account changes (e.g. tradie finished onboarding)
 */
async function handleAccountUpdated(account) {
  const userId = account.metadata?.userId;
  if (!userId) {
    console.warn('Connect account missing userId metadata:', account.id);
    return;
  }

  try {
    await saveConnectStatus(userId, account);
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    console.warn(`Connect account ${account.id} does not match user ${userId}`);
  }
}

module.exports = withCors({
  createPaymentIntent,
  confirmPayment,
  getPayment,
  getBookingPayment,
  connectOnboard,
  connectStatus,
  subscribePro,
  proBillingPortal,
  proStatus,
  handleWebhook,
});
