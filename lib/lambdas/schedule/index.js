const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, now, generateId } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const SCHEDULE_TABLE = process.env.SCHEDULE_TABLE;
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;

/**
 * GET /schedule/tradie/{tradieId}
 * Get tradie's working hours and days off
 */
async function getSchedule(event) {
  try {
    const tradieId = getPathParam(event, 'tradieId');

    if (!tradieId) {
      return errorResponse(400, 'tradieId required');
    }

    // Get working hours
    const hoursResult = await dynamodb.get({
      TableName: SCHEDULE_TABLE,
      Key: {
        tradieId,
        scheduleType: 'working-hours',
      },
    }).promise();

    // Get one-off days and hours that the tradie has blocked.
    const exceptionResult = await dynamodb.query({
      TableName: SCHEDULE_TABLE,
      KeyConditionExpression: 'tradieId = :tradieId',
      ExpressionAttributeValues: {
        ':tradieId': tradieId,
      },
    }).promise();

    const workingHours = hoursResult.Item?.workingHours || getDefaultWorkingHours();
    const travelBuffer = hoursResult.Item?.travelBuffer || 30;
    const exceptions = exceptionResult.Items || [];
    const unavailableDates = exceptions
      .filter((item) => item.scheduleType.startsWith('unavailable-'))
      .map((item) => item.date || item.scheduleType.slice('unavailable-'.length));
    const timeBlocks = exceptions
      .filter((item) => item.scheduleType.startsWith('block-'))
      .map(({ blockId, date, startTime, endTime, reason, createdAt }) => ({
        blockId, date, startTime, endTime, reason: reason || '', createdAt,
      }));

    return response(200, {
      tradieId,
      workingHours,
      unavailableDates,
      timeBlocks,
      travelBuffer,
    });
  } catch (error) {
    console.error('Get schedule error:', error);
    return errorResponse(500, 'Failed to fetch schedule');
  }
}

/**
 * PATCH /schedule/me
 * Update own working hours
 * Body: { workingHours: { Monday: { start, end }, ... }, travelBuffer? }
 */
async function updateSchedule(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const workingHours = body.workingHours || normalizeLegacyWorkingHours(body);
    const travelBuffer = body.travelBuffer ?? 30;

    if (!workingHours) {
      return errorResponse(400, 'workingHours required');
    }

    if (!Number.isFinite(Number(travelBuffer)) || Number(travelBuffer) < 0 || Number(travelBuffer) > 240) {
      return errorResponse(400, 'travelBuffer must be between 0 and 240 minutes');
    }

    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (const day of validDays) {
      const dayHours = workingHours[day];
      if (!dayHours || dayHours.off === true) continue;
      if (!isValidTime(dayHours.start) || !isValidTime(dayHours.end) || dayHours.start >= dayHours.end) {
        return errorResponse(400, `Invalid hours for ${day}`);
      }
    }

    await dynamodb.put({
      TableName: SCHEDULE_TABLE,
      Item: {
        tradieId: userId,
        scheduleType: 'working-hours',
        workingHours,
        travelBuffer: Number(travelBuffer),
        updatedAt: now(),
      },
    }).promise();

    return response(200, {
      tradieId: userId,
      workingHours,
      travelBuffer: Number(travelBuffer),
      message: 'Schedule updated',
    });
  } catch (error) {
    console.error('Update schedule error:', error);
    return errorResponse(500, 'Failed to update schedule');
  }
}

/**
 * POST /schedule/me/unavailable
 * Mark a day as unavailable
 * Body: { date: YYYY-MM-DD }
 */
async function markUnavailable(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const startDate = body.date || body.startDate;
    const endDate = body.date || body.endDate || startDate;

    if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
      return errorResponse(400, 'A valid date range in YYYY-MM-DD format is required');
    }

    const dates = getDateRange(startDate, endDate);
    if (dates.length > 366) {
      return errorResponse(400, 'Unavailable date range cannot exceed 366 days');
    }

    await Promise.all(dates.map((date) => dynamodb.put({
      TableName: SCHEDULE_TABLE,
      Item: {
        tradieId: userId,
        scheduleType: `unavailable-${date}`,
        date,
        reason: body.reason || '',
        createdAt: now(),
      },
    }).promise()));

    return response(201, {
      tradieId: userId,
      startDate,
      endDate,
      dates,
      message: dates.length === 1 ? 'Day marked as unavailable' : 'Dates marked as unavailable',
    });
  } catch (error) {
    console.error('Mark unavailable error:', error);
    return errorResponse(500, 'Failed to mark day unavailable');
  }
}

/**
 * DELETE /schedule/me/unavailable/{date}
 * Remove day off
 */
async function removeUnavailable(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const date = getPathParam(event, 'date');

    if (!date) {
      return errorResponse(400, 'date required');
    }

    // Remove unavailable date
    await dynamodb.delete({
      TableName: SCHEDULE_TABLE,
      Key: {
        tradieId: userId,
        scheduleType: `unavailable-${date}`,
      },
    }).promise();

    return response(200, {
      tradieId: userId,
      date,
      message: 'Unavailable day removed',
    });
  } catch (error) {
    console.error('Remove unavailable error:', error);
    return errorResponse(500, 'Failed to remove unavailable day');
  }
}

/**
 * POST /schedule/me/blocks
 * Block part of a day without changing recurring working hours.
 * Body: { date, startTime, endTime, reason? }
 */
async function createTimeBlock(event) {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, 'Unauthorized');

    const body = getBody(event);
    const { date, startTime, endTime } = body;
    if (!isValidDate(date) || !isValidTime(startTime) || !isValidTime(endTime) || startTime >= endTime) {
      return errorResponse(400, 'A valid date, start time, and end time are required');
    }

    const bookingsResult = await dynamodb.query({
      TableName: BOOKINGS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId AND bookingDate = :date',
      ExpressionAttributeValues: { ':tradieId': userId, ':date': date },
    }).promise();
    const collision = (bookingsResult.Items || []).some((booking) => (
      ['pending', 'accepted'].includes(booking.status)
      && startTime < booking.endTime
      && endTime > booking.startTime
    ));
    if (collision) return errorResponse(409, 'This time already contains a booking request or confirmed job');

    const existing = await dynamodb.query({
      TableName: SCHEDULE_TABLE,
      KeyConditionExpression: 'tradieId = :tradieId AND begins_with(scheduleType, :prefix)',
      ExpressionAttributeValues: { ':tradieId': userId, ':prefix': 'block-' },
    }).promise();
    const overlaps = (existing.Items || []).some((block) => (
      block.date === date && startTime < block.endTime && endTime > block.startTime
    ));
    if (overlaps) return errorResponse(409, 'This time is already blocked');

    const blockId = generateId();
    const block = {
      tradieId: userId,
      scheduleType: `block-${blockId}`,
      blockId,
      date,
      startTime,
      endTime,
      reason: String(body.reason || '').trim().slice(0, 120),
      createdAt: now(),
    };
    await dynamodb.put({ TableName: SCHEDULE_TABLE, Item: block }).promise();
    return response(201, block);
  } catch (error) {
    console.error('Create time block error:', error);
    return errorResponse(500, 'Failed to block this time');
  }
}

/** DELETE /schedule/me/blocks/{blockId} */
async function removeTimeBlock(event) {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, 'Unauthorized');
    const blockId = getPathParam(event, 'blockId');
    if (!/^[0-9a-f-]{36}$/i.test(blockId || '')) return errorResponse(400, 'blockId required');

    await dynamodb.delete({
      TableName: SCHEDULE_TABLE,
      Key: { tradieId: userId, scheduleType: `block-${blockId}` },
    }).promise();
    return response(200, { tradieId: userId, blockId, message: 'Time is available again' });
  } catch (error) {
    console.error('Remove time block error:', error);
    return errorResponse(500, 'Failed to remove time block');
  }
}

function normalizeLegacyWorkingHours(body) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const hasLegacyHours = days.some((day) => `${day.toLowerCase()}Start` in body || `${day.toLowerCase()}End` in body);
  if (!hasLegacyHours) return null;

  return Object.fromEntries(days.map((day) => {
    const key = day.toLowerCase();
    const start = body[`${key}Start`];
    const end = body[`${key}End`];
    return [day, start && end ? { start, end } : { off: true }];
  }));
}

function isValidTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Helper: Get default working hours
 */
function getDefaultWorkingHours() {
  return {
    Monday: { start: '09:00', end: '17:00' },
    Tuesday: { start: '09:00', end: '17:00' },
    Wednesday: { start: '09:00', end: '17:00' },
    Thursday: { start: '09:00', end: '17:00' },
    Friday: { start: '09:00', end: '17:00' },
    Saturday: { off: true },
    Sunday: { off: true },
  };
}

module.exports = {
  getSchedule,
  updateSchedule,
  markUnavailable,
  removeUnavailable,
  createTimeBlock,
  removeTimeBlock,
};
