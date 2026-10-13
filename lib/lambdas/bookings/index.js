const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, now, generateId, isHomeowner } = require('./utils');
const { isSlotAvailable, calculatePricing, BOOKING_STATUSES, isValidStatusTransition } = require('./business-logic');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const SCHEDULE_TABLE = process.env.SCHEDULE_TABLE;
const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

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

    if (!isHomeowner(event.requestContext?.authorizer?.claims)) {
      return errorResponse(403, 'Only homeowners can create bookings');
    }

    const body = getBody(event);
    const { tradieId, date, startTime, endTime, jobType, description } = body;

    if (!tradieId || !date || !startTime || !endTime || !jobType) {
      return errorResponse(400, 'Missing required fields');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
      return errorResponse(400, 'Invalid booking date or time format');
    }

    const tradieResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId: tradieId },
    }).promise();
    if (!tradieResult.Item || tradieResult.Item.role !== 'tradie') {
      return errorResponse(404, 'Tradie not found');
    }

    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    const durationHours = (endMinutes - startMinutes) / 60;
    const hourlyRate = Number(tradieResult.Item.hourlyRate);
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0 || durationHours <= 0) {
      return errorResponse(400, 'This booking does not have valid pricing');
    }
    const pricing = calculatePricing(hourlyRate, durationHours, Boolean(tradieResult.Item.hasHomeinkPro));

    // Get tradie schedule to check availability
    const schedule = await getTradieeSchedule(tradieId);
    if (!schedule) {
      return errorResponse(404, 'Tradie not found');
    }

    // Get existing bookings for this tradie on this date
    const existingResult = await dynamodb.query({
      TableName: BOOKINGS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId AND bookingDate = :date',
      ExpressionAttributeValues: {
        ':tradieId': tradieId,
        ':date': date,
        ':pending': 'pending',
        ':accepted': 'accepted',
        ':completed': 'completed',
      },
      FilterExpression: '#status IN (:pending, :accepted, :completed)',
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
      pricing: {
        hourlyRate,
        durationHours,
        labourSubtotal: pricing.subtotal,
        serviceFee: pricing.homeownerFee,
        total: pricing.homeownerPays,
        currency: 'AUD',
      },
      amountDue: pricing.homeownerPays,
      currency: 'AUD',
      paymentStatus: 'unpaid',
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

    const bookings = result.Items || [];
    const counterpartIds = [...new Set(bookings.map((booking) => (
      role === 'homeowner' ? booking.tradieId : booking.homeownerId
    )).filter(Boolean))];
    let peopleById = {};

    if (counterpartIds.length) {
      const peopleResult = await dynamodb.batchGet({
        RequestItems: {
          [USERS_TABLE]: {
            Keys: counterpartIds.map((userId) => ({ userId })),
            ProjectionExpression: 'userId, #name, #role, trade, #location, hourlyRate',
            ExpressionAttributeNames: {
              '#name': 'name',
              '#role': 'role',
              '#location': 'location',
            },
          },
        },
      }).promise();
      peopleById = Object.fromEntries(
        (peopleResult.Responses?.[USERS_TABLE] || []).map((person) => [person.userId, person])
      );
    }

    const enrichedBookings = bookings.map((booking) => {
      const person = peopleById[role === 'homeowner' ? booking.tradieId : booking.homeownerId];
      return role === 'homeowner'
        ? { ...booking, tradie: person || null }
        : { ...booking, homeowner: person || null };
    });

    return response(200, {
      userId,
      role,
      bookings: enrichedBookings,
      count: enrichedBookings.length,
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
      return errorResponse(403, 'You do not have access to this booking');
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
    const { status, notes, arrivalStatus, etaMinutes, liveLocation, stopLocationSharing } = body;
    const hasLocationUpdate = Boolean(liveLocation) || stopLocationSharing === true;

    if (!bookingId || (!status && !arrivalStatus && !hasLocationUpdate)) {
      return errorResponse(400, 'bookingId and an update are required');
    }

    if ([Boolean(status), Boolean(arrivalStatus), hasLocationUpdate].filter(Boolean).length > 1) {
      return errorResponse(400, 'Update status, arrival, and location separately');
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
      return errorResponse(403, 'You do not have access to this booking');
    }

    if (hasLocationUpdate) {
      if (booking.tradieId !== userId) {
        return errorResponse(403, 'Only the tradie can share a live location');
      }
      if (booking.status !== BOOKING_STATUSES.ACCEPTED) {
        return errorResponse(400, 'Location sharing requires an accepted booking');
      }

      const updatedAt = now();
      if (stopLocationSharing === true) {
        await dynamodb.update({
          TableName: BOOKINGS_TABLE,
          Key: { bookingId },
          UpdateExpression: 'SET locationSharing = :sharing, locationUpdatedAt = :ua, updatedAt = :ua REMOVE liveLocation',
          ExpressionAttributeValues: { ':sharing': false, ':ua': updatedAt },
        }).promise();
      } else {
        const latitude = Number(liveLocation.latitude);
        const longitude = Number(liveLocation.longitude);
        const accuracy = Number(liveLocation.accuracy);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
          || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
          || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000) {
          return errorResponse(400, 'A valid latitude, longitude, and accuracy are required');
        }

        await dynamodb.update({
          TableName: BOOKINGS_TABLE,
          Key: { bookingId },
          UpdateExpression: 'SET liveLocation = :location, locationSharing = :sharing, locationUpdatedAt = :ua, updatedAt = :ua',
          ExpressionAttributeValues: {
            ':location': { latitude, longitude, accuracy },
            ':sharing': true,
            ':ua': updatedAt,
          },
        }).promise();
      }

      const updated = await dynamodb.get({
        TableName: BOOKINGS_TABLE,
        Key: { bookingId },
      }).promise();
      return response(200, updated.Item);
    }

    if (arrivalStatus) {
      if (booking.tradieId !== userId) {
        return errorResponse(403, 'Only the tradie can update arrival status');
      }
      if (booking.status !== BOOKING_STATUSES.ACCEPTED) {
        return errorResponse(400, 'Arrival updates require an accepted booking');
      }
      if (!['en-route', 'arrived'].includes(arrivalStatus)) {
        return errorResponse(400, 'Arrival status must be en-route or arrived');
      }

      const parsedEta = arrivalStatus === 'arrived' ? 0 : Number(etaMinutes);
      if (!Number.isInteger(parsedEta) || parsedEta < 0 || parsedEta > 240) {
        return errorResponse(400, 'ETA must be a whole number from 0 to 240 minutes');
      }

      const updatedAt = now();
      const arrivalUpdate = {
        TableName: BOOKINGS_TABLE,
        Key: { bookingId },
        UpdateExpression: 'SET arrivalStatus = :arrivalStatus, etaMinutes = :eta, arrivalUpdatedAt = :ua, updatedAt = :ua',
        ExpressionAttributeValues: {
          ':arrivalStatus': arrivalStatus,
          ':eta': parsedEta,
          ':ua': updatedAt,
        },
      };
      if (arrivalStatus === 'arrived') {
        arrivalUpdate.UpdateExpression += ', locationSharing = :sharing REMOVE liveLocation';
        arrivalUpdate.ExpressionAttributeValues[':sharing'] = false;
      }
      await dynamodb.update(arrivalUpdate).promise();

      const message = arrivalStatus === 'arrived'
        ? 'Your tradie has arrived'
        : `Your tradie is on the way — around ${parsedEta} minutes away`;
      await createNotification(booking.homeownerId, message, 'arrival-update', bookingId);

      const updated = await dynamodb.get({
        TableName: BOOKINGS_TABLE,
        Key: { bookingId },
      }).promise();
      return response(200, updated.Item);
    }

    // Validate status transition
    if (!isValidStatusTransition(booking.status, status)) {
      return errorResponse(400, `Invalid status transition from ${booking.status} to ${status}`);
    }

    // Authorization check
    if ([BOOKING_STATUSES.ACCEPTED, BOOKING_STATUSES.DECLINED, BOOKING_STATUSES.COMPLETED].includes(status)) {
      if (booking.tradieId !== userId) {
        return errorResponse(403, 'Only the tradie can make this update');
      }
    } else if (status === BOOKING_STATUSES.CANCELLED) {
      if (booking.homeownerId !== userId) {
        return errorResponse(403, 'Only homeowner can cancel');
      }
    }

    // Update booking
    let updateExpression = 'SET #status = :status, #ua = :ua';
    const expressionAttributeNames = { '#status': 'status', '#ua': 'updatedAt' };
    const expressionAttributeValues = { ':status': status, ':ua': now() };

    if (notes) {
      updateExpression += ', notes = :notes';
      expressionAttributeValues[':notes'] = notes;
    }

    if ([BOOKING_STATUSES.COMPLETED, BOOKING_STATUSES.CANCELLED].includes(status)) {
      updateExpression += ', locationSharing = :sharing REMOVE liveLocation';
      expressionAttributeValues[':sharing'] = false;
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

    if (!result.Item) {
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

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return hours * 60 + minutes;
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
