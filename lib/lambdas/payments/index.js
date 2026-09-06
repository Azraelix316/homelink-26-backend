const AWS = require('aws-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { response, errorResponse, getUserId, getBody, now, generateId } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

/**
 * POST /payments/create-payment-intent
 * Create Stripe PaymentIntent for booking payment
 * Body: { bookingId, amount, currency }
 */
async function createPaymentIntent(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const { bookingId, amount, currency } = body;

    if (!bookingId || !amount || !currency) {
      return errorResponse(400, 'Missing required fields: bookingId, amount, currency');
    }

    if (amount <= 0) {
      return errorResponse(400, 'Amount must be greater than 0');
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

    if (booking.status !== 'confirmed') {
      return errorResponse(400, 'Can only pay for confirmed bookings');
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe expects amount in cents
      currency: currency.toLowerCase(),
      metadata: {
        bookingId,
        homeownerId: userId,
      },
      description: `Payment for booking ${bookingId}`,
    });

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
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return errorResponse(400, `Payment not successful. Status: ${paymentIntent.status}`);
    }

    // Update booking with payment confirmation
    const paymentId = generateId();
    await dynamodb.update({
      TableName: process.env.BOOKINGS_TABLE,
      Key: { bookingId },
      UpdateExpression: 'SET paymentStatus = :ps, paymentId = :pid, paymentAmount = :amt, paymentDate = :pd, updatedAt = :ua',
      ExpressionAttributeValues: {
        ':ps': 'paid',
        ':pid': paymentId,
        ':amt': paymentIntent.amount / 100,
        ':pd': now(),
        ':ua': now(),
      },
    }).promise();

    // Create payment record
    await dynamodb.put({
      TableName: process.env.PAYMENTS_TABLE,
      Item: {
        paymentId,
        bookingId,
        homeownerId: userId,
        stripePaymentIntentId: paymentIntentId,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency.toUpperCase(),
        status: 'completed',
        createdAt: now(),
        updatedAt: now(),
      },
    }).promise();

    // Create notification for tradie
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

    return response(200, {
      paymentId,
      bookingId,
      status: 'completed',
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency.toUpperCase(),
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
    const bookingId = event.pathParameters?.bookingId;
    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
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
    const sig = event.headers['stripe-signature'];
    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
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
  const { bookingId, homeownerId } = paymentIntent.metadata;

  if (!bookingId || !homeownerId) {
    console.warn('Payment intent missing metadata:', paymentIntent.id);
    return;
  }

  // Update booking status
  await dynamodb.update({
    TableName: process.env.BOOKINGS_TABLE,
    Key: { bookingId },
    UpdateExpression: 'SET paymentStatus = :ps, updatedAt = :ua',
    ExpressionAttributeValues: {
      ':ps': 'paid',
      ':ua': now(),
    },
  }).promise();

  console.log(`Payment succeeded for booking: ${bookingId}`);
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

module.exports = {
  createPaymentIntent,
  confirmPayment,
  getPayment,
  getBookingPayment,
  handleWebhook,
};
