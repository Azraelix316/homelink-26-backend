const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, now, generateId, isValidDate, isValidTime, isOptionalString, isNumberInRange, withCors } = require('./utils');
const { isSlotAvailable, calculatePricing, timeToMinutes, BOOKING_STATUSES, isValidStatusTransition } = require('./business-logic');

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

// Body fields for live arrival tracking and for rescheduling
const ARRIVAL_FIELDS = ['arrivalStatus', 'etaMinutes', 'liveLocation', 'stopLocationSharing'];
const RESCHEDULE_FIELDS = ['date', 'startTime', 'endTime'];

// Accepted spellings of the arrival states; stored as the frontend reads them
const ARRIVAL_STATUSES = {
  'en-route': 'en-route',
  'on_the_way': 'en-route',
  'on-the-way': 'en-route',
  arrived: 'arrived',
};
const MAX_ETA_MINUTES = 24 * 60;
const RESCHEDULABLE_STATUSES = [BOOKING_STATUSES.PENDING, BOOKING_STATUSES.ACCEPTED];

/**
 * PATCH /bookings/{bookingId}
 * One of:
 * - a status change (accept, decline, complete, cancel): { status, notes? }
 * - a live arrival update from the tradie on an accepted job:
 *   { arrivalStatus?, etaMinutes?, liveLocation?: { latitude, longitude, accuracy? }, stopLocationSharing? }
 * - a reschedule by either party of a pending or accepted job: { date?, startTime?, endTime? }
 */
async function updateBooking(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    const body = getBody(event) || {};
    const has = field => body[field] !== undefined;
    const isStatusChange = has('status');
    const isArrivalUpdate = ARRIVAL_FIELDS.some(has);
    const isReschedule = RESCHEDULE_FIELDS.some(has);

    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }
    const kinds = [isStatusChange, isArrivalUpdate, isReschedule].filter(Boolean).length;
    if (kinds === 0) {
      return errorResponse(400, 'Provide a status, an arrival update or a new date and time');
    }
    if (kinds > 1) {
      return errorResponse(400, 'Send status changes, arrival updates and reschedules as separate requests');
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

    if (isArrivalUpdate) {
      return await updateArrival(booking, body, userId);
    }
    if (isReschedule) {
      return await rescheduleBooking(booking, body, userId);
    }
    return await changeStatus(booking, body, userId);
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      return errorResponse(409, 'The booking changed while you were updating it. Reload and try again');
    }
    console.error('Update booking error:', error);
    return errorResponse(500, 'Failed to update booking');
  }
}

/**
 * Status change: accept, decline, complete or cancel
 */
async function changeStatus(booking, body, userId) {
  const { bookingId } = booking;
  const { status, notes } = body;

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

  // The tradie's live location is only shared while the job is under way
  if (status !== BOOKING_STATUSES.ACCEPTED) {
    updateExpression += ', locationSharing = :sharing REMOVE liveLocation, locationUpdatedAt';
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

  return response(200, await getBookingItem(bookingId));
}

/**
 * Live arrival tracking: the tradie shares that they're on the way (with an
 * ETA), that they've arrived, and/or their live location
 */
async function updateArrival(booking, body, userId) {
  const { bookingId } = booking;
  const { arrivalStatus, etaMinutes, liveLocation, stopLocationSharing } = body;

  if (booking.tradieId !== userId) {
    return errorResponse(403, 'Only the tradie can share arrival updates');
  }

  if (stopLocationSharing !== undefined && stopLocationSharing !== true) {
    return errorResponse(400, 'stopLocationSharing must be true');
  }
  if (stopLocationSharing && liveLocation !== undefined) {
    return errorResponse(400, 'Send either liveLocation or stopLocationSharing, not both');
  }

  const stopOnly = stopLocationSharing === true && arrivalStatus === undefined && etaMinutes === undefined;
  // Stopping is always allowed so the location can be withdrawn at any time
  if (!stopOnly && booking.status !== BOOKING_STATUSES.ACCEPTED) {
    return errorResponse(409, 'Arrival updates are only for accepted bookings');
  }

  const nextArrival = arrivalStatus === undefined ? undefined : ARRIVAL_STATUSES[arrivalStatus];
  if (arrivalStatus !== undefined && !nextArrival) {
    return errorResponse(400, 'arrivalStatus must be en-route or arrived');
  }

  if (etaMinutes !== undefined) {
    if (!isNumberInRange(etaMinutes, 0, MAX_ETA_MINUTES)) {
      return errorResponse(400, `etaMinutes must be a number from 0 to ${MAX_ETA_MINUTES}`);
    }
    if ((nextArrival || booking.arrivalStatus) !== 'en-route') {
      return errorResponse(400, 'etaMinutes is only for a tradie who is on the way');
    }
  }

  let location;
  if (liveLocation !== undefined) {
    const { latitude, longitude, accuracy } = liveLocation || {};
    if (!isNumberInRange(latitude, -90, 90) || !isNumberInRange(longitude, -180, 180)) {
      return errorResponse(400, 'liveLocation needs latitude (-90 to 90) and longitude (-180 to 180)');
    }
    if (accuracy !== undefined && accuracy !== null && !isNumberInRange(accuracy, 0, 100000)) {
      return errorResponse(400, 'liveLocation.accuracy must be metres from 0 to 100000');
    }
    // Keep only the coordinates, never other client-sent fields
    location = { latitude, longitude };
    if (typeof accuracy === 'number') location.accuracy = accuracy;
  }

  const sets = ['#ua = :ua'];
  const removes = [];
  const names = { '#ua': 'updatedAt', '#status': 'status' };
  const values = { ':ua': now(), ':uid': userId };

  if (nextArrival) {
    sets.push('arrivalStatus = :arrival', 'arrivalUpdatedAt = :ua');
    values[':arrival'] = nextArrival;
    if (nextArrival === 'arrived') removes.push('etaMinutes');
  }
  if (etaMinutes !== undefined) {
    sets.push('etaMinutes = :eta');
    values[':eta'] = Math.round(etaMinutes);
  }
  if (location) {
    sets.push('liveLocation = :loc', 'locationSharing = :sharing', 'locationUpdatedAt = :locAt');
    values[':loc'] = location;
    values[':sharing'] = true;
    values[':locAt'] = new Date().toISOString();
  }
  if (stopLocationSharing) {
    sets.push('locationSharing = :sharing');
    values[':sharing'] = false;
    removes.push('liveLocation', 'locationUpdatedAt');
  }

  // Re-check the tradie and status atomically, so a job that was completed or
  // cancelled meanwhile doesn't start sharing location again
  let condition = 'tradieId = :uid';
  if (!stopOnly) {
    condition += ' AND #status = :accepted';
    values[':accepted'] = BOOKING_STATUSES.ACCEPTED;
  }

  await dynamodb.update({
    TableName: BOOKINGS_TABLE,
    Key: { bookingId },
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ConditionExpression: condition,
    ExpressionAttributeNames: stopOnly ? { '#ua': 'updatedAt' } : names,
    ExpressionAttributeValues: values,
  }).promise();

  // Tell the homeowner when the tradie sets off or arrives (not on every ETA tweak)
  if (nextArrival && nextArrival !== booking.arrivalStatus) {
    if (nextArrival === 'en-route') {
      const eta = etaMinutes !== undefined ? ` and about ${Math.round(etaMinutes)} minutes away` : '';
      await createNotification(booking.homeownerId, `Your tradie is on the way${eta}`, 'tradie-en-route', bookingId);
    } else {
      await createNotification(booking.homeownerId, 'Your tradie has arrived', 'tradie-arrived', bookingId);
    }
  }

  return response(200, await getBookingItem(bookingId));
}

/**
 * Reschedule: either party moves a pending or accepted booking to a new
 * date/time, re-checked against the tradie's availability
 */
async function rescheduleBooking(booking, body, userId) {
  const { bookingId } = booking;
  const date = body.date ?? booking.date;
  const startTime = body.startTime ?? booking.startTime;
  const endTime = body.endTime ?? booking.endTime;

  if (!RESCHEDULABLE_STATUSES.includes(booking.status)) {
    return errorResponse(409, 'Only pending or accepted bookings can be rescheduled');
  }

  if (!isValidDate(date) || !isValidTime(startTime) || !isValidTime(endTime) || startTime >= endTime) {
    return errorResponse(400, 'Invalid date or time. Use YYYY-MM-DD and HH:MM, with startTime before endTime');
  }

  if (date < new Date().toISOString().slice(0, 10)) {
    return errorResponse(400, 'Cannot book a date in the past');
  }

  if (date === booking.date && startTime === booking.startTime && endTime === booking.endTime) {
    return errorResponse(400, 'The booking is already at that date and time');
  }

  // A paid booking keeps its price: the new duration must cost the same
  if (booking.paymentStatus === 'paid') {
    const priceError = await checkPaidPriceUnchanged(booking, startTime, endTime);
    if (priceError) return priceError;
  }

  // Check availability the same way createBooking does, ignoring this booking
  const schedule = await getTradieeSchedule(booking.tradieId);
  if (!schedule) {
    return errorResponse(404, 'Tradie not found');
  }

  const existingResult = await dynamodb.query({
    TableName: BOOKINGS_TABLE,
    IndexName: 'TradieIdIndex',
    KeyConditionExpression: 'tradieId = :tradieId',
    ExpressionAttributeValues: {
      ':tradieId': booking.tradieId,
      ':date': date,
      ':pending': 'pending',
      ':accepted': 'accepted',
      ':completed': 'completed',
    },
    FilterExpression: 'bookingDate = :date AND #status IN (:pending, :accepted, :completed)',
    ExpressionAttributeNames: { '#status': 'status' },
  }).promise();

  const otherBookings = (existingResult.Items || []).filter(item => item.bookingId !== bookingId);

  const availability = isSlotAvailable(
    date,
    startTime,
    endTime,
    schedule.workingHours,
    schedule.unavailableDates,
    otherBookings,
    schedule.travelBuffer || 30
  );

  if (!availability.available) {
    return errorResponse(409, `Time slot not available: ${availability.reason}`);
  }

  const values = {
    ':date': date,
    ':start': startTime,
    ':end': endTime,
    ':ua': now(),
    ':by': userId,
    ':sharing': false,
    ':oldDate': booking.date,
    ':oldStart': booking.startTime,
    ':oldEnd': booking.endTime,
    ':pending': BOOKING_STATUSES.PENDING,
    ':accepted': BOOKING_STATUSES.ACCEPTED,
    ':previous': { date: booking.date, startTime: booking.startTime, endTime: booking.endTime },
  };
  // Fail if the booking moved, changed status or was paid in the meantime
  let condition = '#date = :oldDate AND startTime = :oldStart AND endTime = :oldEnd'
    + ' AND #status IN (:pending, :accepted)';
  if (booking.paymentStatus) {
    condition += ' AND paymentStatus = :ps';
    values[':ps'] = booking.paymentStatus;
  } else {
    condition += ' AND attribute_not_exists(paymentStatus)';
  }

  await dynamodb.update({
    TableName: BOOKINGS_TABLE,
    Key: { bookingId },
    UpdateExpression: 'SET #date = :date, bookingDate = :date, startTime = :start, endTime = :end, '
      + 'previousSchedule = :previous, rescheduledAt = :ua, rescheduledBy = :by, #ua = :ua, locationSharing = :sharing '
      // Arrival details belonged to the old time
      + 'REMOVE arrivalStatus, arrivalUpdatedAt, etaMinutes, liveLocation, locationUpdatedAt',
    ConditionExpression: condition,
    ExpressionAttributeNames: { '#date': 'date', '#status': 'status', '#ua': 'updatedAt' },
    ExpressionAttributeValues: values,
  }).promise();

  const otherParty = userId === booking.tradieId ? booking.homeownerId : booking.tradieId;
  const who = userId === booking.tradieId ? 'Your tradie' : 'The homeowner';
  await createNotification(
    otherParty,
    `${who} moved your booking to ${date}, ${startTime} to ${endTime}`,
    'booking-rescheduled',
    bookingId
  );

  return response(200, await getBookingItem(bookingId));
}

/**
 * Helper: a paid booking may only move to a time that costs exactly what the
 * homeowner paid (the charge is the tradie's rate times the duration)
 */
async function checkPaidPriceUnchanged(booking, startTime, endTime) {
  const tradieResult = await dynamodb.get({
    TableName: USERS_TABLE,
    Key: { userId: booking.tradieId },
  }).promise();
  const tradie = tradieResult.Item;
  if (!tradie || !(tradie.hourlyRate > 0)) {
    return errorResponse(409, 'This paid booking cannot be repriced, so it cannot be rescheduled');
  }

  const chargeCents = (start, end) => {
    const hours = (timeToMinutes(end) - timeToMinutes(start)) / 60;
    const pricing = calculatePricing(tradie.hourlyRate, hours, tradie.hasHomeinkPro || false);
    return Math.round(pricing.homeownerPays * 100);
  };

  const paidCents = typeof booking.paymentAmount === 'number'
    ? Math.round(booking.paymentAmount * 100)
    : chargeCents(booking.startTime, booking.endTime);
  const newCents = chargeCents(startTime, endTime);

  if (newCents !== paidCents) {
    return errorResponse(
      409,
      `This booking is paid ($${(paidCents / 100).toFixed(2)}) and the new time would cost `
        + `$${(newCents / 100).toFixed(2)}. Keep the same duration, or refund and rebook`
    );
  }
  return null;
}

/**
 * Helper: Read a booking by ID
 */
async function getBookingItem(bookingId) {
  const result = await dynamodb.get({
    TableName: BOOKINGS_TABLE,
    Key: { bookingId },
  }).promise();
  return result.Item;
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

module.exports = withCors({
  createBooking,
  getUserBookings,
  getBooking,
  updateBooking,
});
