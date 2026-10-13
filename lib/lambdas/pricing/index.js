const AWS = require('aws-sdk');
const { response, errorResponse, getBody, getPathParam } = require('./utils');
const { calculatePricing } = require('./business-logic');
const { buildEstimate } = require('./estimate');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

async function estimatePrice(event) {
  try {
    const body = getBody(event);
    const trade = String(body.trade || '').trim();
    const location = String(body.location || '').trim().toLowerCase();
    const description = String(body.description || '').trim();
    const durationHours = body.durationHours === undefined ? undefined : Number(body.durationHours);

    if (!trade || trade.length > 80) return errorResponse(400, 'A valid trade is required');
    if (description.length > 500) return errorResponse(400, 'Job description must be 500 characters or fewer');
    if (durationHours !== undefined && (!Number.isFinite(durationHours) || durationHours < 0.5 || durationHours > 24)) {
      return errorResponse(400, 'Duration must be between 0.5 and 24 hours');
    }

    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      ProjectionExpression: '#role, #name, email, trade, #location, hourlyRate',
      ExpressionAttributeNames: { '#role': 'role', '#name': 'name', '#location': 'location' },
    }).promise();
    const matching = (result.Items || []).filter((item) =>
      item.role === 'tradie' &&
      !isSyntheticProfile(item) &&
      String(item.trade || '').toLowerCase() === trade.toLowerCase()
    );
    const local = location
      ? matching.filter((item) => String(item.location || '').toLowerCase().includes(location))
      : [];
    const sample = local.length >= 2 ? local : matching;

    return response(200, buildEstimate({
      trade,
      rates: sample.map((item) => item.hourlyRate),
      durationHours,
      description,
    }));
  } catch (error) {
    console.error('Estimate pricing error:', error);
    return errorResponse(500, 'Failed to estimate price');
  }
}

function isSyntheticProfile(item) {
  const email = String(item.email || '').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  return email.endsWith('@example.com') || /\b(test|demo|smoke)\b/.test(name);
}

/**
 * POST /pricing/calculate
 * Calculate pricing breakdown for a booking
 * Body: { hourlyRate, hours, hasHomeinkPro? }
 */
async function calculatePrice(event) {
  try {
    const body = getBody(event);
    const hours = Number(body.hours ?? body.hoursEstimated);
    let hourlyRate = Number(body.hourlyRate);
    let hasHomeinkPro = Boolean(body.hasHomeinkPro);

    if (body.tradieId) {
      const tradieResult = await dynamodb.get({
        TableName: USERS_TABLE,
        Key: { userId: body.tradieId },
      }).promise();

      if (!tradieResult.Item || tradieResult.Item.role !== 'tradie') {
        return errorResponse(404, 'Tradie not found');
      }

      hourlyRate = Number(tradieResult.Item.hourlyRate);
      hasHomeinkPro = Boolean(tradieResult.Item.hasHomeinkPro);
    }

    if (!Number.isFinite(hourlyRate) || !Number.isFinite(hours) || hourlyRate <= 0 || hours <= 0) {
      return errorResponse(400, 'A valid tradie or hourly rate and positive hours are required');
    }

    const pricing = calculatePricing(hourlyRate, hours, hasHomeinkPro);

    return response(200, pricing);
  } catch (error) {
    console.error('Calculate pricing error:', error);
    return errorResponse(500, 'Failed to calculate pricing');
  }
}

/**
 * GET /pricing/breakdown/{bookingId}
 * Get pricing breakdown for a specific booking
 */
async function getPricingBreakdown(event) {
  try {
    const bookingId = getPathParam(event, 'bookingId');

    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
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

    // Get tradie info for rate
    const tradieResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId: booking.tradieId },
    }).promise();

    if (!tradieResult.Item) {
      return errorResponse(404, 'Tradie not found');
    }

    // Calculate hours from start and end time
    const startMinutes = timeToMinutes(booking.startTime);
    const endMinutes = timeToMinutes(booking.endTime);
    const minutes = endMinutes - startMinutes;
    const hours = minutes / 60;

    if (hours <= 0) {
      return errorResponse(400, 'Invalid booking times');
    }

    // Check if tradie has HomeLink Pro (could be stored on user record)
    const hasHomeinkPro = tradieResult.Item.hasHomeinkPro || false;

    const pricing = calculatePricing(tradieResult.Item.hourlyRate, hours, hasHomeinkPro);

    return response(200, {
      bookingId,
      tradieId: booking.tradieId,
      tradieHourlyRate: tradieResult.Item.hourlyRate,
      duration: { hours, minutes },
      ...pricing,
    });
  } catch (error) {
    console.error('Get pricing breakdown error:', error);
    return errorResponse(500, 'Failed to fetch pricing breakdown');
  }
}

/**
 * Helper: Convert time string to minutes
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

module.exports = {
  estimatePrice,
  calculatePrice,
  getPricingBreakdown,
};
