const AWS = require('aws-sdk');
const { response, errorResponse, getPathParam, getQueryParam, getBody, now, isValidDate, isValidTime, withCors } = require('./utils');
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

    // The frontend's calendar asks for a week at a time with ?from=&to=
    if (!date && (getQueryParam(event, 'from') || getQueryParam(event, 'to'))) {
      return await getAvailabilityRange(event);
    }

    if (!tradieId || !date) {
      return errorResponse(400, 'tradieId and date (or from and to) required');
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

    // Check the span before building the list, so a huge range can't tie up the Lambda
    const spanDays = (Date.parse(toDate) - Date.parse(fromDate)) / 86400000;
    if (!isValidDate(fromDate) || !isValidDate(toDate) || spanDays < 0 || spanDays >= 90) {
      return errorResponse(400, 'from and to must be YYYY-MM-DD dates, at most 90 days apart');
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

    // One query for the whole range (paged), rather than one per day
    const bookings = [];
    let startKey;
    do {
      const page = await dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'TradieIdIndex',
        // The index is sorted by bookingDate, so only this range is read
        KeyConditionExpression: 'tradieId = :tradieId AND bookingDate BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':tradieId': tradieId,
          ':from': fromDate,
          ':to': toDate,
          ':pending': 'pending',
          ':accepted': 'accepted',
          ':completed': 'completed',
        },
        FilterExpression: '#status IN (:pending, :accepted, :completed)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExclusiveStartKey: startKey,
      }).promise();
      bookings.push(...(page.Items || []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    // Slots carry the reason an hour is unavailable (booked, off-hours,
    // day-off), which the calendar shows
    const availabilityByDate = {};
    for (const date of dates) {
      const slots = getHourlySlots(
        date,
        schedule.workingHours,
        schedule.unavailableDates,
        bookings.filter(booking => booking.date === date || booking.bookingDate === date),
        schedule.travelBuffer || 30
      );

      const availableHours = slots.filter(s => s.available).map(s => s.hour);
      availabilityByDate[date] = {
        availableCount: availableHours.length,
        hours: availableHours,
        slots,
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

    if (!isValidDate(date) || !isValidTime(startTime) || !isValidTime(endTime) || startTime >= endTime) {
      return errorResponse(400, 'Invalid date or time. Use YYYY-MM-DD and HH:MM, with startTime before endTime');
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

    const unavailable = await dynamodb.query({
      TableName: SCHEDULE_TABLE,
      KeyConditionExpression: 'tradieId = :tradieId AND begins_with(scheduleType, :prefix)',
      ExpressionAttributeValues: { ':tradieId': tradieId, ':prefix': 'unavailable-' },
    }).promise();
    const unavailableDates = (unavailable.Items || []).map(item => item.scheduleType.slice('unavailable-'.length));

    if (!result.Item) {
      // Return default schedule if not set
      return {
        unavailableDates,
        workingHours: {
          Monday: { start: '09:00', end: '17:00' },
          Tuesday: { start: '09:00', end: '17:00' },
          Wednesday: { start: '09:00', end: '17:00' },
          Thursday: { start: '09:00', end: '17:00' },
          Friday: { start: '09:00', end: '17:00' },
          Saturday: { off: true },
          Sunday: { off: true },
        },
        travelBuffer: 30,
      };
    }

    return { ...result.Item, unavailableDates };
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

module.exports = withCors({
  getAvailability,
  getAvailabilityRange,
  checkAvailability,
});
