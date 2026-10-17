const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getUserRole, getBody, getPathParam, now, isValidDate, isValidTime, withCors } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const SCHEDULE_TABLE = process.env.SCHEDULE_TABLE;

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

    // Get all unavailable dates
    const unavailableResult = await dynamodb.query({
      TableName: SCHEDULE_TABLE,
      KeyConditionExpression: 'tradieId = :tradieId AND begins_with(scheduleType, :prefix)',
      ExpressionAttributeValues: {
        ':tradieId': tradieId,
        ':prefix': 'unavailable-',
      },
    }).promise();

    const workingHours = hoursResult.Item?.workingHours || getDefaultWorkingHours();
    const travelBuffer = hoursResult.Item?.travelBuffer || 30;
    const unavailableDates = (unavailableResult.Items || []).map(item => item.scheduleType.slice('unavailable-'.length));

    return response(200, {
      tradieId,
      workingHours,
      unavailableDates,
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

    if (getUserRole(event) !== 'tradie') {
      return errorResponse(403, 'Only tradies have a schedule');
    }

    const body = getBody(event);
    const { workingHours } = body;
    const travelBuffer = body.travelBuffer === undefined ? 30 : body.travelBuffer;

    if (!workingHours || typeof workingHours !== 'object' || Array.isArray(workingHours)) {
      return errorResponse(400, 'workingHours required');
    }

    if (!Number.isInteger(travelBuffer) || travelBuffer < 0 || travelBuffer > 240) {
      return errorResponse(400, 'travelBuffer must be a whole number of minutes from 0 to 240');
    }

    // Validate working hours format, keeping only the fields we understand
    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const unknownDay = Object.keys(workingHours).find(key => !validDays.includes(key));
    if (unknownDay) {
      return errorResponse(400, `Unknown day: ${unknownDay}`);
    }

    const cleanHours = {};
    for (const day of validDays) {
      const dayHours = workingHours[day];
      if (!dayHours) continue;
      if (dayHours.off === true) {
        cleanHours[day] = { off: true };
        continue;
      }
      if (!isValidTime(dayHours.start) || !isValidTime(dayHours.end) || dayHours.start >= dayHours.end) {
        return errorResponse(400, `Invalid hours for ${day}. Use HH:MM with start before end`);
      }
      cleanHours[day] = { start: dayHours.start, end: dayHours.end };
    }

    // Update schedule
    await dynamodb.put({
      TableName: SCHEDULE_TABLE,
      Item: {
        tradieId: userId,
        scheduleType: 'working-hours',
        workingHours: cleanHours,
        travelBuffer,
        updatedAt: now(),
      },
    }).promise();

    return response(200, {
      tradieId: userId,
      workingHours: cleanHours,
      travelBuffer,
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

    if (getUserRole(event) !== 'tradie') {
      return errorResponse(403, 'Only tradies have a schedule');
    }

    const body = getBody(event);
    const { date } = body;

    if (!isValidDate(date)) {
      return errorResponse(400, 'date required (YYYY-MM-DD format)');
    }

    // Add unavailable date
    await dynamodb.put({
      TableName: SCHEDULE_TABLE,
      Item: {
        tradieId: userId,
        scheduleType: `unavailable-${date}`,
        date,
        createdAt: now(),
      },
    }).promise();

    return response(201, {
      tradieId: userId,
      date,
      message: 'Day marked as unavailable',
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

    if (!isValidDate(date)) {
      return errorResponse(400, 'date required (YYYY-MM-DD format)');
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

module.exports = withCors({
  getSchedule,
  updateSchedule,
  markUnavailable,
  removeUnavailable,
});
