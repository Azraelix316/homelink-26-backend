const AWS = require('aws-sdk');
const { response, errorResponse, getBody, getPathParam } = require('../utils');
const { calculatePricing } = require('../business-logic');

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
  calculatePrice,
  getPricingBreakdown,
};
