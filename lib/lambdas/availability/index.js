const AWS = require('aws-sdk');
const { response, errorResponse, getPathParam, getQueryParam, getBody, now } = require('./utils');
const { getHourlySlots, isSlotAvailable } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const SCHEDULE_TABLE = process.env.SCHEDULE_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

/**
 * GET /availability/tradie/{tradieId}?date={YYYY-MM-DD}
 * Get available hours for a specific tradie on a date
 */
async function getAvailability(event) {
  try {
    const tradieId = getPathParam(event, 'tradieId');
    const date = getQueryParam(event, 'date');

    if (!tradieId || !date) {
      return errorResponse(400, 'tradieId and date required');
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return errorResponse(400, 'Invalid date format. Use YYYY-MM-DD');
    }

    // Get tradie's schedule
    const schedule = await getTradieeSchedule(tradieId);
    if (!schedule) {
      return errorResponse(404, 'Tradie schedule not found');
    }

    // Get tradie's bookings for this date
    const bookingsResult = await dynamodb.query({
      TableName: BOOKINGS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId',
      ExpressionAttributeValues: {
        ':tradieId': tradieId,
        ':date': date,
        ':pending': 'pending',
        ':accepted': 'accepted',
        ':completed': 'completed',
      },
      FilterExpression: 'bookingDate = :date AND #status IN (:pending, :accepted, :completed)',
      ExpressionAttributeNames: { '#status': 'status' },
    }).promise();

    const bookings = bookingsResult.Items || [];

    // Get hourly slots
    const slots = getHourlySlots(
      date,
      schedule.workingHours,
      schedule.unavailableDates,
      bookings,
      schedule.travelBuffer || 30
    );

    return response(200, {
      tradieId,
      date,
      slots,
      workingHours: schedule.workingHours,
    });
  } catch (error) {
    console.error('Get availability error:', error);
    return errorResponse(500, 'Failed to fetch availability');
  }
}

/**
 * GET /availability/tradie/{tradieId}?from={date}&to={date}
 * Get availability for a date range
 */
async function getAvailabilityRange(event) {
  try {
    const tradieId = getPathParam(event, 'tradieId');
    const fromDate = getQueryParam(event, 'from');
    const toDate = getQueryParam(event, 'to');

    if (!tradieId || !fromDate || !toDate) {
      return errorResponse(400, 'tradieId, from, and to required');
    }

    // Get tradie's schedule
    const schedule = await getTradieeSchedule(tradieId);
    if (!schedule) {
      return errorResponse(404, 'Tradie schedule not found');
    }

    // Generate date range
    const dates = getDateRange(fromDate, toDate);
    if (dates.length > 90) {
      return errorResponse(400, 'Date range cannot exceed 90 days');
    }

    // Get availability for each date
    const availabilityByDate = {};

    for (const date of dates) {
      const bookingsResult = await dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'TradieIdIndex',
        KeyConditionExpression: 'tradieId = :tradieId',
        ExpressionAttributeValues: {
          ':tradieId': tradieId,
          ':date': date,
          ':pending': 'pending',
          ':accepted': 'accepted',
          ':completed': 'completed',
        },
        FilterExpression: 'bookingDate = :date AND #status IN (:pending, :accepted, :completed)',
        ExpressionAttributeNames: { '#status': 'status' },
      }).promise();

      const bookings = bookingsResult.Items || [];
      const slots = getHourlySlots(
        date,
        schedule.workingHours,
        schedule.unavailableDates,
        bookings,
        schedule.travelBuffer || 30
      );

      // Count available hours
      const availableHours = slots.filter(s => s.available).map(s => s.hour);
      availabilityByDate[date] = {
        availableCount: availableHours.length,
        hours: availableHours,
      };
    }

    return response(200, {
      tradieId,
      fromDate,
      toDate,
      availabilityByDate,
    });
  } catch (error) {
    console.error('Get availability range error:', error);
    return errorResponse(500, 'Failed to fetch availability range');
  }
}

/**
 * POST /availability/check
 * Check if a specific slot is available
 */
async function checkAvailability(event) {
  try {
    const body = getBody(event);
    const { tradieId, date, startTime, endTime } = body;

    if (!tradieId || !date || !startTime || !endTime) {
      return errorResponse(400, 'tradieId, date, startTime, endTime required');
    }

    // Get tradie's schedule
    const schedule = await getTradieeSchedule(tradieId);
    if (!schedule) {
      return errorResponse(404, 'Tradie schedule not found');
    }

    // Get tradie's bookings
    const bookingsResult = await dynamodb.query({
      TableName: BOOKINGS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId',
      ExpressionAttributeValues: {
        ':tradieId': tradieId,
        ':date': date,
        ':pending': 'pending',
        ':accepted': 'accepted',
        ':completed': 'completed',
      },
      FilterExpression: 'bookingDate = :date AND #status IN (:pending, :accepted, :completed)',
      ExpressionAttributeNames: { '#status': 'status' },
    }).promise();

    const bookings = bookingsResult.Items || [];

    // Check if slot is available
    const availability = isSlotAvailable(
      date,
      startTime,
      endTime,
      schedule.workingHours,
      schedule.unavailableDates,
      bookings,
      schedule.travelBuffer || 30
    );

    return response(200, {
      tradieId,
      date,
      startTime,
      endTime,
      ...availability,
    });
  } catch (error) {
    console.error('Check availability error:', error);
    return errorResponse(500, 'Failed to check availability');
  }
}

/**
 * Helper: Get tradie schedule
 */
async function getTradieeSchedule(tradieId) {
  try {
    const result = await dynamodb.get({
      TableName: SCHEDULE_TABLE,
      Key: {
        tradieId,
        scheduleType: 'working-hours',
      },
    }).promise();

    if (!result.Item) {
      // Return default schedule if not set
      return {
        workingHours: {
          Monday: { start: '09:00', end: '17:00' },
          Tuesday: { start: '09:00', end: '17:00' },
          Wednesday: { start: '09:00', end: '17:00' },
          Thursday: { start: '09:00', end: '17:00' },
          Friday: { start: '09:00', end: '17:00' },
          Saturday: { off: true },
          Sunday: { off: true },
        },
        unavailableDates: [],
        travelBuffer: 30,
      };
    }

    return result.Item;
  } catch (error) {
    console.error('Get tradie schedule error:', error);
    return null;
  }
}

/**
 * Generate array of dates between two dates (inclusive)
 */
function getDateRange(fromDate, toDate) {
  const dates = [];
  const current = new Date(fromDate);
  const end = new Date(toDate);

  while (current <= end) {
    const year = current.getUTCFullYear();
    const month = String(current.getUTCMonth() + 1).padStart(2, '0');
    const day = String(current.getUTCDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

module.exports = {
  getAvailability,
  getAvailabilityRange,
  checkAvailability,
};
