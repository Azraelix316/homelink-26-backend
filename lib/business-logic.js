/**
 * Availability engine - core business logic for determining available time slots
 */

/**
 * Parse time string in HH:MM format (24-hour) to minutes since midnight
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Get day of week (0=Sunday, 1=Monday, etc)
 */
function getDayOfWeek(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  return date.getUTCDay();
}

/**
 * Get list of hourly slots for a given date
 * Returns array of {hour, available: boolean}
 */
function getHourlySlots(date, workingHours, unavailableDates, bookings, travelBuffer = 30, timeBlocks = []) {
  const slots = [];
  const dayOfWeek = getDayOfWeek(date);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];
  
  // Check if marked as day off
  if (unavailableDates && unavailableDates.includes(date)) {
    for (let hour = 0; hour < 24; hour++) {
      slots.push({ hour, available: false, reason: 'day-off' });
    }
    return slots;
  }

  // Get working hours for this day
  const dayHours = workingHours?.[dayName] || null;
  if (!dayHours || dayHours.off) {
    for (let hour = 0; hour < 24; hour++) {
      slots.push({ hour, available: false, reason: 'off-hours' });
    }
    return slots;
  }

  const startMinutes = timeToMinutes(dayHours.start);
  const endMinutes = timeToMinutes(dayHours.end);

  // Generate hourly slots
  for (let hour = 0; hour < 24; hour++) {
    const hourStart = hour * 60;
    const hourEnd = (hour + 1) * 60;

    // Check if within working hours
    if (hourStart < startMinutes || hourEnd > endMinutes) {
      slots.push({ hour, available: false, reason: 'off-hours' });
      continue;
    }

    // Check if booked (with travel buffer)
    const blocked = (timeBlocks || []).some((block) => (
      block.date === date
      && hourStart < timeToMinutes(block.endTime)
      && hourEnd > timeToMinutes(block.startTime)
    ));
    if (blocked) {
      slots.push({ hour, available: false, reason: 'blocked' });
      continue;
    }

    let booked = false;
    for (const booking of bookings || []) {
      if (booking.date !== date) continue;

      const bookingStart = timeToMinutes(booking.startTime);
      const bookingEnd = timeToMinutes(booking.endTime);

      // Check with buffer: [bookingStart - buffer, bookingEnd + buffer)
      if (hourStart < bookingEnd + travelBuffer && hourEnd > bookingStart - travelBuffer) {
        booked = true;
        break;
      }
    }

    slots.push({
      hour,
      available: !booked,
      reason: booked ? 'booked' : 'available',
    });
  }

  return slots;
}

/**
 * Check if a specific time slot is available
 * slotStart and slotEnd are in HH:MM format
 */
function isSlotAvailable(date, slotStart, slotEnd, workingHours, unavailableDates, bookings, travelBuffer = 30, timeBlocks = []) {
  const dayOfWeek = getDayOfWeek(date);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];

  // Check if day is marked as unavailable
  if (unavailableDates && unavailableDates.includes(date)) {
    return { available: false, reason: 'day-off' };
  }

  // Check working hours
  const dayHours = workingHours?.[dayName];
  if (!dayHours || dayHours.off) {
    return { available: false, reason: 'off-hours' };
  }

  const slotStartMin = timeToMinutes(slotStart);
  const slotEndMin = timeToMinutes(slotEnd);
  const workStart = timeToMinutes(dayHours.start);
  const workEnd = timeToMinutes(dayHours.end);

  // Check if slot is within working hours
  if (slotStartMin < workStart || slotEndMin > workEnd) {
    return { available: false, reason: 'off-hours' };
  }

  const blocked = (timeBlocks || []).some((block) => (
    block.date === date
    && slotStartMin < timeToMinutes(block.endTime)
    && slotEndMin > timeToMinutes(block.startTime)
  ));
  if (blocked) return { available: false, reason: 'blocked' };

  // Check against existing bookings (with buffer)
  for (const booking of bookings || []) {
    if (booking.date !== date) continue;

    const bookingStart = timeToMinutes(booking.startTime);
    const bookingEnd = timeToMinutes(booking.endTime);

    // Check for overlap with buffer: [start - buffer, end + buffer)
    if (slotStartMin < bookingEnd + travelBuffer && slotEndMin > bookingStart - travelBuffer) {
      return { available: false, reason: 'booked' };
    }
  }

  return { available: true, reason: 'available' };
}

/**
 * Pricing calculations
 */

/**
 * Calculate pricing breakdown for a booking
 * @param hourlyRate - tradie's hourly rate
 * @param hours - duration in hours
 * @param hasHomeinkPro - if true, tradie commission is 0% instead of 10%
 * @returns breakdown with subtotal, commissions, final price
 */
function calculatePricing(hourlyRate, hours, hasPro = false) {
  const subtotal = hourlyRate * hours;
  
  // Commission: 10% to tradie if no pro, 5% service fee to homeowner
  const tradieCommissionPercent = hasPro ? 0 : 0.1;
  const homeownerFeePercent = 0.05;

  const tradieCommission = subtotal * tradieCommissionPercent;
  const homeownerFee = subtotal * homeownerFeePercent;

  // Tradie receives
  const tradieEarns = subtotal - tradieCommission;

  // Homeowner pays
  const homeownerPays = subtotal + homeownerFee;

  return {
    hourlyRate,
    hours,
    subtotal,
    tradieCommissionPercent: tradieCommissionPercent * 100,
    tradieCommission,
    tradieEarns,
    homeownerFeePercent: homeownerFeePercent * 100,
    homeownerFee,
    homeownerPays,
    hasPro,
  };
}

/**
 * Status precedence for displaying availability
 * Priority order (earliest to latest):
 * 1. past (date is in the past)
 * 2. too-soon (less than 24 hours away)
 * 3. day-off (marked as unavailable)
 * 4. off-hours (outside working hours)
 * 5. blocked (explicitly blocked time)
 * 6. booked (has a booking)
 * 7. buffer (affected by travel buffer)
 * 8. pending (pending booking exists)
 * 9. available
 */
function getStatusPrecedence(status) {
  const precedence = {
    'past': 0,
    'too-soon': 1,
    'day-off': 2,
    'off-hours': 3,
    'blocked': 4,
    'booked': 5,
    'buffer': 6,
    'pending': 7,
    'available': 8,
  };
  return precedence[status] ?? 9;
}

/**
 * Booking status lifecycle
 */
const BOOKING_STATUSES = {
  PENDING: 'pending',      // Awaiting tradie response
  ACCEPTED: 'accepted',    // Tradie accepted
  DECLINED: 'declined',    // Tradie declined
  COMPLETED: 'completed',  // Job completed
  CANCELLED: 'cancelled',  // Homeowner cancelled
  REVIEWED: 'reviewed',    // Review submitted
};

/**
 * Valid status transitions
 */
function isValidStatusTransition(currentStatus, newStatus) {
  const validTransitions = {
    'pending': ['accepted', 'declined', 'cancelled'],
    'accepted': ['completed', 'cancelled'],
    'completed': ['reviewed'],
    'declined': [],
    'cancelled': [],
    'reviewed': [],
  };
  return (validTransitions[currentStatus] || []).includes(newStatus);
}

module.exports = {
  timeToMinutes,
  getDayOfWeek,
  getHourlySlots,
  isSlotAvailable,
  calculatePricing,
  getStatusPrecedence,
  BOOKING_STATUSES,
  isValidStatusTransition,
};
