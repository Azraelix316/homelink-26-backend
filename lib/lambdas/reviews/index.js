const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, now, generateId } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const REVIEWS_TABLE = process.env.REVIEWS_TABLE;
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

/**
 * POST /reviews
 * Create a review for a completed booking
 * Body: { bookingId, rating, comment }
 */
async function createReview(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const { bookingId, rating, comment } = body;

    if (!bookingId || rating === undefined) {
      return errorResponse(400, 'bookingId and rating required');
    }

    const parsedRating = Number(rating);
    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return errorResponse(400, 'Rating must be a whole number between 1 and 5');
    }

    // Get booking
    const bookingResult = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!bookingResult.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = bookingResult.Item;

    // Verify booking is completed
    if (booking.status !== 'completed') {
      return errorResponse(400, 'Can only review completed bookings');
    }

    // Verify user is homeowner
    if (booking.homeownerId !== userId) {
      return errorResponse(403, 'Only homeowner can review this booking');
    }

    // Check if review already exists
    const existingResult = await dynamodb.query({
      TableName: REVIEWS_TABLE,
      IndexName: 'BookingIdIndex',
      KeyConditionExpression: 'bookingId = :bookingId',
      ExpressionAttributeValues: { ':bookingId': bookingId },
    }).promise();

    if (existingResult.Items && existingResult.Items.length > 0) {
      return errorResponse(409, 'Review already exists for this booking');
    }

    // Create review
    const reviewId = generateId();
    const review = {
      reviewId,
      bookingId,
      tradieId: booking.tradieId,
      homeownerId: userId,
      rating: parsedRating,
      comment: comment || '',
      createdAt: now(),
    };

    await dynamodb.put({
      TableName: REVIEWS_TABLE,
      Item: review,
    }).promise();

    // Update booking status to reviewed
    await dynamodb.update({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
      UpdateExpression: 'SET #status = :status, #ua = :ua',
      ExpressionAttributeNames: { '#status': 'status', '#ua': 'updatedAt' },
      ExpressionAttributeValues: { ':status': 'reviewed', ':ua': now() },
    }).promise();

    return response(201, review);
  } catch (error) {
    console.error('Create review error:', error);
    return errorResponse(500, 'Failed to create review');
  }
}

/**
 * GET /reviews/tradie/{tradieId}
 * Get all reviews for a tradie
 */
async function getTradieReviews(event) {
  try {
    const tradieId = getPathParam(event, 'tradieId');
    const limit = Number(getQueryParam(event, 'limit') || 20);
    const offset = Number(getQueryParam(event, 'offset') || 0);

    if (!tradieId) {
      return errorResponse(400, 'tradieId required');
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return errorResponse(400, 'limit must be 1-100 and offset must be zero or greater');
    }

    const result = await dynamodb.query({
      TableName: REVIEWS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId',
      ExpressionAttributeValues: { ':tradieId': tradieId },
      ScanIndexForward: false,
    }).promise();

    const reviews = result.Items || [];

    // Calculate stats
    const averageRating = reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
      : 0;

    const ratingDistribution = {
      5: 0, 4: 0, 3: 0, 2: 0, 1: 0,
    };

    reviews.forEach(r => {
      ratingDistribution[r.rating]++;
    });

    return response(200, {
      tradieId,
      reviews: reviews.slice(offset, offset + limit),
      averageRating: parseFloat(averageRating),
      reviewCount: reviews.length,
      ratingDistribution,
    });
  } catch (error) {
    console.error('Get tradie reviews error:', error);
    return errorResponse(500, 'Failed to fetch reviews');
  }
}

/**
 * GET /reviews?booking_id={id}
 * Get review for a specific booking (if it exists)
 */
async function getBookingReview(event) {
  try {
    const bookingId = getQueryParam(event, 'booking_id') || getQueryParam(event, 'bookingId');

    if (!bookingId) {
      return errorResponse(400, 'booking_id required');
    }

    const result = await dynamodb.query({
      TableName: REVIEWS_TABLE,
      IndexName: 'BookingIdIndex',
      KeyConditionExpression: 'bookingId = :bookingId',
      ExpressionAttributeValues: { ':bookingId': bookingId },
    }).promise();

    const reviews = result.Items || [];

    if (reviews.length === 0) {
      return response(200, { review: null });
    }

    return response(200, { review: reviews[0] });
  } catch (error) {
    console.error('Get booking review error:', error);
    return errorResponse(500, 'Failed to fetch review');
  }
}

/**
 * GET /reviews/{reviewId}
 * Get a specific review
 */
async function getReview(event) {
  try {
    const reviewId = getPathParam(event, 'reviewId');

    if (!reviewId) {
      return errorResponse(400, 'reviewId required');
    }

    const result = await dynamodb.get({
      TableName: REVIEWS_TABLE,
      Key: { reviewId },
    }).promise();

    if (!result.Item) {
      return errorResponse(404, 'Review not found');
    }

    return response(200, result.Item);
  } catch (error) {
    console.error('Get review error:', error);
    return errorResponse(500, 'Failed to fetch review');
  }
}

module.exports = {
  createReview,
  getTradieReviews,
  getBookingReview,
  getReview,
};
