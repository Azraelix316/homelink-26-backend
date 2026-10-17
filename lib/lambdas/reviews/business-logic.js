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
function getHourlySlots(date, workingHours, unavailableDates, bookings, travelBuffer = 30) {
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
function isSlotAvailable(date, slotStart, slotEnd, workingHours, unavailableDates, bookings, travelBuffer = 30) {
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
 * @returns breakdown with subtotal, commissions, card processing fee, final price
 */
function calculatePricing(hourlyRate, hours, hasPro = false) {
  // Work in cents so every figure is a whole number of cents
  const subtotalCents = Math.round(hourlyRate * hours * 100);

  // Commission: 10% to tradie if no pro, 5% service fee to homeowner
  const tradieCommissionPercent = hasPro ? 0 : 0.1;
  const homeownerFeePercent = 0.05;

  const tradieCommissionCents = Math.round(subtotalCents * tradieCommissionPercent);
  const homeownerFeeCents = Math.round(subtotalCents * homeownerFeePercent);

  // Card processing: gross the price up so Stripe's fee (percent + fixed) is
  // paid by the homeowner rather than coming out of HomeLink's fees
  const cardFeePercent = Number(process.env.STRIPE_FEE_PERCENT || 0.0165);
  const cardFeeFixedCents = Math.round(Number(process.env.STRIPE_FEE_FIXED || 0.30) * 100);
  const homeownerPaysCents = Math.ceil((subtotalCents + homeownerFeeCents + cardFeeFixedCents) / (1 - cardFeePercent));
  const processingFeeCents = homeownerPaysCents - subtotalCents - homeownerFeeCents;

  // Tradie receives the job price minus commission; HomeLink collects the rest
  const tradieEarnsCents = subtotalCents - tradieCommissionCents;
  const applicationFeeCents = homeownerPaysCents - tradieEarnsCents;

  const dollars = cents => cents / 100;
  return {
    hourlyRate,
    hours,
    subtotal: dollars(subtotalCents),
    tradieCommissionPercent: tradieCommissionPercent * 100,
    tradieCommission: dollars(tradieCommissionCents),
    tradieEarns: dollars(tradieEarnsCents),
    homeownerFeePercent: homeownerFeePercent * 100,
    homeownerFee: dollars(homeownerFeeCents),
    processingFee: dollars(processingFeeCents),
    homeownerPays: dollars(homeownerPaysCents),
    applicationFee: dollars(applicationFeeCents),
    hasPro,
  };
}

/**
 * Price guide for a job, from what tradies in the trade charge per hour
 */

// Typical Sydney hourly rates, used when the marketplace has no data for a trade
const BASELINE_HOURLY_RATES = {
  Carpentry: 90,
  Cleaning: 55,
  Electrical: 110,
  Gardening: 65,
  Handyman: 75,
  Painting: 70,
  Plumbing: 105,
};
const DEFAULT_BASELINE_RATE = 80;
// Rates outside this band are treated as typos or placeholders
const ESTIMATE_RATE_MIN = 30;
const ESTIMATE_RATE_MAX = 400;

/**
 * Linear-interpolated percentile (fraction 0..1) of a list of numbers
 */
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Estimate a job's labour cost range for durationHours (0.5..24).
 * The low end uses the 25th percentile rate over 75% of the hours, the high
 * end the 75th percentile rate over 150% of the hours, rounded to $5.
 * HomeLink's service and card fees are not included.
 */
function estimateJobPrice(trade, rates, durationHours) {
  const validRates = (rates || []).filter(
    rate => Number.isFinite(rate) && rate >= ESTIMATE_RATE_MIN && rate <= ESTIMATE_RATE_MAX
  );
  const hoursLow = Math.max(0.5, Math.round(durationHours * 0.75 * 2) / 2);
  const hoursHigh = Math.min(24, Math.max(hoursLow, Math.round(durationHours * 1.5 * 2) / 2));
  const baseline = BASELINE_HOURLY_RATES[trade] || DEFAULT_BASELINE_RATE;

  let lowRate;
  let highRate;
  if (validRates.length > 1) {
    lowRate = percentile(validRates, 0.25);
    highRate = percentile(validRates, 0.75);
  } else {
    const rate = validRates.length === 1 ? validRates[0] : baseline;
    lowRate = rate * 0.85;
    highRate = rate * 1.15;
  }

  const roundMoney = value => Math.round(value / 5) * 5;
  return {
    currency: 'AUD',
    low: roundMoney(lowRate * hoursLow),
    high: roundMoney(highRate * hoursHigh),
    hours: { low: hoursLow, high: hoursHigh },
    sampleSize: validRates.length,
    source: validRates.length ? 'marketplace' : 'baseline',
    includesServiceFee: false,
    disclaimer: 'Guide only. The tradie confirms the final scope and price before work starts.',
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
  percentile,
  estimateJobPrice,
  getStatusPrecedence,
  BOOKING_STATUSES,
  isValidStatusTransition,
};
