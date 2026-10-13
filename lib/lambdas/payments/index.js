const AWS = require('aws-sdk');
const Stripe = require('stripe');
const { response, errorResponse, getUserId, getBody, now, generateId } = require('./utils');
const { calculatePricing } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const secrets = new AWS.SecretsManager({ region: process.env.AWS_REGION || 'ap-southeast-2' });
let stripeConfigPromise;

async function getStripeConfig() {
  if (!stripeConfigPromise) {
    stripeConfigPromise = secrets.getSecretValue({ SecretId: process.env.STRIPE_SECRET_NAME }).promise()
      .then((result) => {
        const raw = result.SecretString || Buffer.from(result.SecretBinary || '', 'base64').toString('utf8');
        let value;
        try { value = JSON.parse(raw); } catch { value = { secretKey: raw }; }
        const secretKey = value.secretKey || value.STRIPE_SECRET_KEY;
        if (!secretKey) throw new Error('Stripe secret key is not configured');
        return {
          client: new Stripe(secretKey),
          webhookSecret: value.webhookSecret || value.STRIPE_WEBHOOK_SECRET || '',
        };
      });
  }
  return stripeConfigPromise;
}

/**
 * POST /payments/create-payment-intent
 * Create Stripe PaymentIntent for booking payment
 * Body: { bookingId }
 */
async function createPaymentIntent(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const { bookingId } = body;

    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }

    // Get booking to verify homeowner owns it
    const bookingResult = await dynamodb.get({
      TableName: process.env.BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!bookingResult.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = bookingResult.Item;
    if (booking.homeownerId !== userId) {
      return errorResponse(403, 'Not authorized to pay for this booking');
    }

    if (booking.status !== 'accepted') {
      return errorResponse(400, 'Can only pay for accepted bookings');
    }
    if (booking.paymentStatus === 'paid') {
      return errorResponse(409, 'This booking is already paid');
    }

    const { amount, currency } = await amountForBooking(booking);
    const { client } = await getStripeConfig();
    const paymentIntent = booking.stripePaymentIntentId
      ? await client.paymentIntents.retrieve(booking.stripePaymentIntentId)
      : await client.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: { bookingId, homeownerId: userId },
        description: `Payment for booking ${bookingId}`,
      }, { idempotencyKey: `booking-${bookingId}` });

    // Store payment intent ID in bookings table
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

    return response(200, {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount / 100, // Return in original currency
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

    const body = getBody(event);
    const { bookingId, paymentIntentId } = body;

    if (!bookingId || !paymentIntentId) {
      return errorResponse(400, 'Missing required fields: bookingId, paymentIntentId');
    }

    // Get booking
    const bookingResult = await dynamodb.get({
      TableName: process.env.BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!bookingResult.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = bookingResult.Item;
    if (booking.homeownerId !== userId) {
      return errorResponse(403, 'Not authorized to confirm payment for this booking');
    }

    // Retrieve payment intent from Stripe
    if (booking.stripePaymentIntentId !== paymentIntentId) {
      return errorResponse(400, 'Payment intent does not belong to this booking');
    }

    const { client } = await getStripeConfig();
    const paymentIntent = await client.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return errorResponse(400, `Payment not successful. Status: ${paymentIntent.status}`);
    }

    const payment = await finalizePayment(paymentIntent, booking);

    return response(200, {
      paymentId: payment.paymentId,
      bookingId,
      status: 'completed',
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
 * Get payment details
 */
async function getPayment(event) {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, 'Unauthorized');
    const paymentId = event.pathParameters?.paymentId;
    if (!paymentId) {
      return errorResponse(400, 'paymentId required');
    }

    const result = await dynamodb.get({
      TableName: process.env.PAYMENTS_TABLE,
      Key: { paymentId },
    }).promise();

    if (!result.Item) {
      return errorResponse(404, 'Payment not found');
    }

    if (!(await canAccessBooking(userId, result.Item.bookingId))) {
      return errorResponse(403, 'You do not have access to this payment');
    }

    return response(200, result.Item);
  } catch (error) {
    console.error('Get payment error:', error);
    return errorResponse(500, 'Failed to fetch payment');
  }
}

/**
 * GET /payments/booking/{bookingId}
 * Get payment for a specific booking
 */
async function getBookingPayment(event) {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, 'Unauthorized');
    const bookingId = event.pathParameters?.bookingId;
    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }

    if (!(await canAccessBooking(userId, bookingId))) {
      return errorResponse(403, 'You do not have access to this payment');
    }

    const result = await dynamodb.query({
      TableName: process.env.PAYMENTS_TABLE,
      IndexName: 'BookingIdIndex',
      KeyConditionExpression: 'bookingId = :bid',
      ExpressionAttributeValues: {
        ':bid': bookingId,
      },
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
 * POST /payments/webhook
 * Stripe webhook handler for payment events
 */
async function handleWebhook(event) {
  try {
    const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
    let stripeEvent;

    try {
      const { client, webhookSecret } = await getStripeConfig();
      if (!webhookSecret) throw new Error('Stripe webhook secret is not configured');
      const payload = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64')
        : event.body;
      stripeEvent = client.webhooks.constructEvent(
        payload,
        sig,
        webhookSecret
      );
    } catch (error) {
      console.error('Webhook signature verification failed:', error.message);
      return errorResponse(400, 'Webhook signature verification failed');
    }

    // Handle the event
    switch (stripeEvent.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(stripeEvent.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(stripeEvent.data.object);
        break;

      case 'payment_intent.canceled':
        await handlePaymentCanceled(stripeEvent.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return response(200, { received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return errorResponse(500, 'Webhook processing failed');
  }
}

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent) {
  const { bookingId } = paymentIntent.metadata;

  if (!bookingId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  const result = await dynamodb.get({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
  }).promise();
  if (!result.Item) {
    console.warn('Payment booking not found:', bookingId);
    return;
  }

  await finalizePayment(paymentIntent, result.Item);

  console.log(`Payment succeeded for booking: ${bookingId}`);
}

async function finalizePayment(paymentIntent, booking) {
  const paidAt = now();
  const amount = paymentIntent.amount / 100;
  const currency = paymentIntent.currency.toUpperCase();
  const paymentId = `stripe-${paymentIntent.id}`;
  const alreadyPaid = booking.paymentStatus === 'paid';

  await dynamodb.update({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId: booking.bookingId },
    UpdateExpression: 'SET paymentStatus = :ps, paymentId = :pid, paymentAmount = :amt, paymentDate = if_not_exists(paymentDate, :pd), updatedAt = :ua',
    ExpressionAttributeValues: {
      ':ps': 'paid',
      ':pid': paymentId,
      ':amt': amount,
      ':pd': paidAt,
      ':ua': paidAt,
    },
  }).promise();

  const payment = {
    paymentId,
    bookingId: booking.bookingId,
    homeownerId: booking.homeownerId,
    tradieId: booking.tradieId,
    stripePaymentIntentId: paymentIntent.id,
    amount,
    currency,
    status: 'completed',
    createdAt: paidAt,
    updatedAt: paidAt,
  };
  await dynamodb.put({
    TableName: process.env.PAYMENTS_TABLE,
    Item: payment,
  }).promise();

  if (!alreadyPaid) {
    await dynamodb.put({
      TableName: process.env.NOTIFICATIONS_TABLE,
      Item: {
        notificationId: generateId(),
        userId: booking.tradieId,
        type: 'payment_received',
        message: `Payment received for booking ${booking.bookingId}`,
        bookingId: booking.bookingId,
        read: false,
        createdAt: paidAt,
        updatedAt: paidAt,
      },
    }).promise();
  }

  return payment;
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent) {
  const { bookingId } = paymentIntent.metadata;

  if (!bookingId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  // Update booking status
  await dynamodb.update({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
    UpdateExpression: 'SET paymentStatus = :ps, updatedAt = :ua',
    ExpressionAttributeValues: {
      ':ps': 'payment_failed',
      ':ua': now(),
    },
  }).promise();

  console.log(`Payment failed for booking: ${bookingId}`);
}

/**
 * Handle canceled payment
 */
async function handlePaymentCanceled(paymentIntent) {
  const { bookingId } = paymentIntent.metadata;

  if (!bookingId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  // Update booking status
  await dynamodb.update({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
    UpdateExpression: 'SET paymentStatus = :ps, updatedAt = :ua',
    ExpressionAttributeValues: {
      ':ps': 'payment_cancelled',
      ':ua': now(),
    },
  }).promise();

  console.log(`Payment cancelled for booking: ${bookingId}`);
}

async function amountForBooking(booking) {
  const storedAmount = Number(booking.amountDue);
  if (Number.isFinite(storedAmount) && storedAmount > 0) {
    return { amount: storedAmount, currency: booking.currency || 'AUD' };
  }

  const tradieResult = await dynamodb.get({
    TableName: process.env.USERS_TABLE,
    Key: { userId: booking.tradieId },
  }).promise();
  const hourlyRate = Number(tradieResult.Item?.hourlyRate);
  const [startHour, startMinute] = String(booking.startTime || '').split(':').map(Number);
  const [endHour, endMinute] = String(booking.endTime || '').split(':').map(Number);
  const hours = ((endHour * 60 + endMinute) - (startHour * 60 + startMinute)) / 60;
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0 || !Number.isFinite(hours) || hours <= 0) {
    throw new Error('Booking pricing is unavailable');
  }
  const pricing = calculatePricing(hourlyRate, hours, Boolean(tradieResult.Item?.hasHomeinkPro));
  return { amount: pricing.homeownerPays, currency: 'AUD' };
}

async function canAccessBooking(userId, bookingId) {
  const result = await dynamodb.get({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
  }).promise();
  return result.Item && [result.Item.homeownerId, result.Item.tradieId].includes(userId);
}

module.exports = {
  createPaymentIntent,
  confirmPayment,
  getPayment,
  getBookingPayment,
  handleWebhook,
};
