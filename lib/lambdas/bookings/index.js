const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, now, generateId, isValidDate, isValidTime, isOptionalString } = require('./utils');
const { isSlotAvailable, BOOKING_STATUSES, isValidStatusTransition } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const SCHEDULE_TABLE = process.env.SCHEDULE_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE;

/**
 * POST /bookings
 * Create a new booking
 * Body: { tradieId, homeownerId, date, startTime, endTime, jobType, description }
 */
async function createBooking(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const { tradieId, date, startTime, endTime, jobType, description } = body;

    if (!tradieId || !date || !startTime || !endTime || !jobType) {
      return errorResponse(400, 'Missing required fields');
    }

    if (!isValidDate(date) || !isValidTime(startTime) || !isValidTime(endTime) || startTime >= endTime) {
      return errorResponse(400, 'Invalid date or time. Use YYYY-MM-DD and HH:MM, with startTime before endTime');
    }

    if (date < new Date().toISOString().slice(0, 10)) {
      return errorResponse(400, 'Cannot book a date in the past');
    }

    if (typeof jobType !== 'string' || jobType.length > 100 || !isOptionalString(description, 2000)) {
      return errorResponse(400, 'jobType must be at most 100 characters and description at most 2000');
    }

    if (tradieId === userId) {
      return errorResponse(400, 'You cannot book yourself');
    }

    // Make sure the tradie exists (otherwise bookings could reference any ID)
    const tradieResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId: tradieId },
    }).promise();
    if (!tradieResult.Item || tradieResult.Item.role !== 'tradie') {
      return errorResponse(404, 'Tradie not found');
    }

    // Get tradie schedule to check availability
    const schedule = await getTradieeSchedule(tradieId);
    if (!schedule) {
      return errorResponse(404, 'Tradie not found');
    }

    // Get existing bookings for this tradie on this date
    const existingResult = await dynamodb.query({
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

    const existingBookings = existingResult.Items || [];

    // Check availability
    const availability = isSlotAvailable(
      date,
      startTime,
      endTime,
      schedule.workingHours,
      schedule.unavailableDates,
      existingBookings,
      schedule.travelBuffer || 30
    );

    if (!availability.available) {
      return errorResponse(409, `Time slot not available: ${availability.reason}`);
    }

    // Create booking
    const bookingId = generateId();
    const booking = {
      bookingId,
      tradieId,
      homeownerId: userId,
      date,
      startTime,
      endTime,
      jobType,
      description: description || '',
      status: BOOKING_STATUSES.PENDING,
      createdAt: now(),
      updatedAt: now(),
      bookingDate: date, // For index
    };

    await dynamodb.put({
      TableName: BOOKINGS_TABLE,
      Item: booking,
    }).promise();

    // Create notification for tradie
    await createNotification(tradieId, `New booking request from homeowner`, 'booking-request', bookingId);

    return response(201, booking);
  } catch (error) {
    console.error('Create booking error:', error);
    return errorResponse(500, 'Failed to create booking');
  }
}

/**
 * GET /bookings?user_id={id}&role={homeowner|tradie}
 * Get user's bookings
 */
async function getUserBookings(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const role = getQueryParam(event, 'role');
    if (!role || !['homeowner', 'tradie'].includes(role)) {
      return errorResponse(400, 'role parameter required: homeowner or tradie');
    }

    let result;
    if (role === 'homeowner') {
      result = await dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'HomeownerIdIndex',
        KeyConditionExpression: 'homeownerId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false, // Most recent first
      }).promise();
    } else {
      result = await dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'TradieIdIndex',
        KeyConditionExpression: 'tradieId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false,
      }).promise();
    }

    return response(200, {
      userId,
      role,
      bookings: result.Items || [],
      count: result.Items?.length || 0,
    });
  } catch (error) {
    console.error('Get user bookings error:', error);
    return errorResponse(500, 'Failed to fetch bookings');
  }
}

/**
 * GET /bookings/{bookingId}
 * Get single booking details
 */
async function getBooking(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }

    const result = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!result.Item) {
      return errorResponse(404, 'Booking not found');
    }

    if (result.Item.homeownerId !== userId && result.Item.tradieId !== userId) {
      return errorResponse(403, 'Not authorized to view this booking');
    }

    return response(200, result.Item);
  } catch (error) {
    console.error('Get booking error:', error);
    return errorResponse(500, 'Failed to fetch booking');
  }
}

/**
 * PATCH /bookings/{bookingId}
 * Update booking status (accept, decline, complete, cancel, review)
 * Body: { status, notes? }
 */
async function updateBooking(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    const body = getBody(event);
    const { status, notes } = body;

    if (!bookingId || !status) {
      return errorResponse(400, 'bookingId and status required');
    }

    // Get current booking
    const result = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!result.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = result.Item;

    if (booking.homeownerId !== userId && booking.tradieId !== userId) {
      return errorResponse(403, 'Not authorized to update this booking');
    }

    if (!isOptionalString(notes, 2000)) {
      return errorResponse(400, 'notes must be at most 2000 characters');
    }

    // Validate status transition
    if (!isValidStatusTransition(booking.status, status)) {
      return errorResponse(400, `Invalid status transition from ${booking.status} to ${status}`);
    }

    // Authorization check
    if (status === BOOKING_STATUSES.ACCEPTED || status === BOOKING_STATUSES.DECLINED) {
      if (booking.tradieId !== userId) {
        return errorResponse(403, 'Only tradie can accept or decline');
      }
    } else if (status === BOOKING_STATUSES.COMPLETED) {
      if (booking.tradieId !== userId) {
        return errorResponse(403, 'Only tradie can mark a job completed');
      }
    } else if (status === BOOKING_STATUSES.CANCELLED) {
      if (booking.homeownerId !== userId) {
        return errorResponse(403, 'Only homeowner can cancel');
      }
      if (booking.paymentStatus === 'paid') {
        return errorResponse(409, 'Paid bookings must be refunded before they can be cancelled');
      }
    } else if (status === BOOKING_STATUSES.REVIEWED) {
      return errorResponse(400, 'Leave a review to mark a booking reviewed');
    }

    // Update booking
    let updateExpression = 'SET #status = :status, #ua = :ua';
    const expressionAttributeNames = { '#status': 'status', '#ua': 'updatedAt' };
    const expressionAttributeValues = { ':status': status, ':ua': now() };

    if (notes) {
      updateExpression += ', notes = :notes';
      expressionAttributeValues[':notes'] = notes;
    }

    await dynamodb.update({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }).promise();

    // Create notifications based on status change
    if (status === BOOKING_STATUSES.ACCEPTED) {
      await createNotification(booking.homeownerId, 'Tradie accepted your booking', 'booking-accepted', bookingId);
    } else if (status === BOOKING_STATUSES.DECLINED) {
      await createNotification(booking.homeownerId, 'Tradie declined your booking', 'booking-declined', bookingId);
    } else if (status === BOOKING_STATUSES.COMPLETED) {
      await createNotification(booking.homeownerId, 'Job completed! Please leave a review', 'job-completed', bookingId);
    } else if (status === BOOKING_STATUSES.CANCELLED) {
      await createNotification(booking.tradieId, 'Booking was cancelled', 'booking-cancelled', bookingId);
    }

    // Get updated booking
    const updated = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    return response(200, updated.Item);
  } catch (error) {
    console.error('Update booking error:', error);
    return errorResponse(500, 'Failed to update booking');
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
 * Helper: Create notification
 */
async function createNotification(userId, message, type, relatedId) {
  try {
    const notificationId = generateId();
    await dynamodb.put({
      TableName: NOTIFICATIONS_TABLE,
      Item: {
        userId,
        notificationId,
        message,
        type,
        relatedId,
        read: false,
        createdAt: now(),
      },
    }).promise();
  } catch (error) {
    console.error('Create notification error:', error);
  }
}

module.exports = {
  createBooking,
  getUserBookings,
  getBooking,
  updateBooking,
};
