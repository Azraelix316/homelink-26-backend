const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, isOptionalString, isNumberInRange, withCors } = require('./utils');
const { calculatePricing, estimateJobPrice } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

/**
 * POST /pricing/calculate
 * Calculate pricing breakdown for a booking
 * Body: { hourlyRate, hours, hasHomeinkPro? }
 */
async function calculatePrice(event) {
  try {
    const body = getBody(event);
    const { hourlyRate, hours, hasHomeinkPro } = body;

    if (hourlyRate === undefined || hours === undefined) {
      return errorResponse(400, 'hourlyRate and hours required');
    }

    if (parseFloat(hourlyRate) <= 0 || parseFloat(hours) <= 0) {
      return errorResponse(400, 'hourlyRate and hours must be positive numbers');
    }

    const pricing = calculatePricing(parseFloat(hourlyRate), parseFloat(hours), hasHomeinkPro || false);

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
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

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
    if (booking.homeownerId !== userId && booking.tradieId !== userId) {
      return errorResponse(403, 'Not authorized to view this booking');
    }

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

// Fewer tradies than this in the homeowner's area falls back to the whole trade
const MIN_LOCAL_SAMPLE = 3;
// Upper bound on index items read per estimate
const MAX_RATE_SAMPLES = 2000;

/**
 * POST /pricing/estimate (public)
 * Price guide for a job from what tradies in the trade charge
 * Body: { trade, location?, description?, durationHours }
 */
async function estimatePrice(event) {
  try {
    const body = getBody(event) || {};
    const { location, description, durationHours } = body;
    const trade = typeof body.trade === 'string' ? body.trade.trim() : '';

    if (!trade || trade.length > 100) {
      return errorResponse(400, 'trade is required (at most 100 characters)');
    }
    if (!isOptionalString(location, 100) || !isOptionalString(description, 2000)) {
      return errorResponse(400, 'location must be at most 100 characters and description at most 2000');
    }
    if (!isNumberInRange(durationHours, 0.5, 24)) {
      return errorResponse(400, 'durationHours must be a number from 0.5 to 24');
    }

    const tradies = await getTradeRates(trade);
    const area = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const local = area
      ? tradies.filter(tradie => (tradie.location || '').trim().toLowerCase() === area)
      : [];
    const sample = local.length >= MIN_LOCAL_SAMPLE ? local : tradies;

    return response(200, estimateJobPrice(trade, sample.map(tradie => tradie.hourlyRate), durationHours));
  } catch (error) {
    console.error('Estimate pricing error:', error);
    return errorResponse(500, 'Failed to estimate price');
  }
}

/**
 * Helper: hourly rates of verified tradies in a trade, via the Users
 * TradeRateIndex (only tradies have a trade and hourlyRate)
 */
async function getTradeRates(trade) {
  // Trades are stored capitalised ("Plumbing"); accept "plumbing" too
  const names = [...new Set([trade, trade.charAt(0).toUpperCase() + trade.slice(1)])];
  const tradies = [];

  for (const name of names) {
    let lastKey;
    do {
      const result = await dynamodb.query({
        TableName: USERS_TABLE,
        IndexName: 'TradeRateIndex',
        KeyConditionExpression: 'trade = :trade',
        ExpressionAttributeValues: { ':trade': name },
        ExclusiveStartKey: lastKey,
      }).promise();
      for (const item of result.Items || []) {
        // Skip tradies who never verified their email, as search does
        if (item.role === 'tradie' && item.emailVerified !== false) tradies.push(item);
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey && tradies.length < MAX_RATE_SAMPLES);
  }

  return tradies;
}

/**
 * Helper: Convert time string to minutes
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

module.exports = withCors({
  calculatePrice,
  getPricingBreakdown,
  estimatePrice,
});
