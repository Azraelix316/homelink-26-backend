const { DynamoDBClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { response, errorResponse, getUserId, getBody, getPathParam, now } = require('./utils');

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

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
    const unavailableDates = (unavailableResult.Items || []).map(item => item.scheduleType.split('-')[1]);

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

    const body = getBody(event);
    const { workingHours, travelBuffer } = body;

    if (!workingHours) {
      return errorResponse(400, 'workingHours required');
    }

    // Validate working hours format
    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (const day of validDays) {
      if (workingHours[day]) {
        const dayHours = workingHours[day];
        if (dayHours.off !== true) {
          if (!dayHours.start || !dayHours.end) {
            return errorResponse(400, `Invalid hours for ${day}`);
          }
          if (!/^\d{2}:\d{2}$/.test(dayHours.start) || !/^\d{2}:\d{2}$/.test(dayHours.end)) {
            return errorResponse(400, `Invalid time format for ${day}`);
          }
        }
      }
    }

    // Update schedule
    await dynamodb.put({
      TableName: SCHEDULE_TABLE,
      Item: {
        tradieId: userId,
        scheduleType: 'working-hours',
        workingHours,
        travelBuffer: travelBuffer || 30,
        updatedAt: now(),
      },
    }).promise();

    return response(200, {
      tradieId: userId,
      workingHours,
      travelBuffer: travelBuffer || 30,
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
    const { date } = body;

    if (!date) {
      return errorResponse(400, 'date required (YYYY-MM-DD format)');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return errorResponse(400, 'Invalid date format. Use YYYY-MM-DD');
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
};

