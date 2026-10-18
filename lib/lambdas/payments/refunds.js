/**
 * Refund policy for cancelling a paid booking. Pure functions: no AWS or
 * Stripe calls, so the rules can be read and tested in one place.
 *
 * The policy is the business's decision, so every number comes from
 * configuration (Lambda environment, set from CDK context):
 *
 *   REFUNDS_ENABLED             'true' to turn cancellation with refund on (default off)
 *   REFUND_CUTOFF_HOURS         homeowner cancels at least this long before the job: full refund
 *   REFUND_LATE_PERCENT         homeowner cancels later: this % of the job price is refunded
 *   REFUND_KEEP_SERVICE_FEE     'true': the 5% service fee is not refunded to a homeowner who cancels
 *   REFUND_KEEP_PROCESSING_FEE  'true': the card-fee markup is not refunded to a homeowner who cancels
 *   BUSINESS_TIMEZONE           time zone booking times are in (default Australia/Sydney)
 *
 * A tradie cancelling always refunds the homeowner in full. HomeLink then
 * covers Stripe's card fee, which Stripe does not return on refunds.
 */

const DEFAULTS = {
  cutoffHours: 24,
  latePercent: 50,
  keepServiceFee: true,
  keepProcessingFee: true,
};

function readPolicy(env = process.env) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const flag = (value, fallback) => (value === undefined || value === '' ? fallback : value === 'true');
  return {
    enabled: env.REFUNDS_ENABLED === 'true',
    cutoffHours: number(env.REFUND_CUTOFF_HOURS, DEFAULTS.cutoffHours, 0, 24 * 30),
    latePercent: number(env.REFUND_LATE_PERCENT, DEFAULTS.latePercent, 0, 100),
    keepServiceFee: flag(env.REFUND_KEEP_SERVICE_FEE, DEFAULTS.keepServiceFee),
    keepProcessingFee: flag(env.REFUND_KEEP_PROCESSING_FEE, DEFAULTS.keepProcessingFee),
    timeZone: env.BUSINESS_TIMEZONE || 'Australia/Sydney',
  };
}

/**
 * Milliseconds since the epoch for a wall-clock date and time in a time zone
 * (e.g. '2026-11-03', '09:00' in Australia/Sydney), daylight saving included.
 */
function zonedTimeToEpoch(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  const offsetAt = (epoch) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return wall - epoch;
  };
  // Two passes settle the offset either side of a daylight-saving change
  let epoch = asUtc - offsetAt(asUtc);
  epoch = asUtc - offsetAt(epoch);
  return epoch;
}

/**
 * What a cancellation refunds, in cents.
 *
 * @param breakdown  cents: { homeownerPays, subtotal, serviceFee, processingFee, tradieEarns }
 * @param cancelledBy 'homeowner' | 'tradie'
 * @param hoursUntilStart hours from now until the job starts
 * @returns { refundCents, tradieReversalCents, platformKeepsCents, rule }
 *   refundCents          back to the homeowner's card
 *   tradieReversalCents  taken back from the tradie's payout
 *   platformKeepsCents   HomeLink's share of what the homeowner paid that stays charged
 */
function quoteRefund(policy, breakdown, cancelledBy, hoursUntilStart) {
  const { homeownerPays, subtotal, serviceFee, processingFee, tradieEarns } = breakdown;

  if (cancelledBy === 'tradie') {
    return {
      refundCents: homeownerPays,
      tradieReversalCents: tradieEarns,
      platformKeepsCents: 0,
      rule: 'tradie-cancelled',
    };
  }

  const early = hoursUntilStart >= policy.cutoffHours;
  const share = early ? 1 : policy.latePercent / 100;
  const jobRefund = Math.round(subtotal * share);
  const feeRefund = (policy.keepServiceFee ? 0 : serviceFee) + (policy.keepProcessingFee ? 0 : processingFee);
  const refundCents = Math.min(homeownerPays, jobRefund + feeRefund);
  // The tradie gives back the same share of what they earned from the job
  const tradieReversalCents = Math.round(tradieEarns * share);

  return {
    refundCents,
    tradieReversalCents,
    platformKeepsCents: homeownerPays - refundCents - (tradieEarns - tradieReversalCents),
    rule: early ? 'before-cutoff' : 'after-cutoff',
  };
}

module.exports = { readPolicy, quoteRefund, zonedTimeToEpoch, DEFAULTS };
