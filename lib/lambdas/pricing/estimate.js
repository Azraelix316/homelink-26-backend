const { calculatePricing } = require('./business-logic');

const BASELINE_RATES = {
  Carpentry: 90,
  Cleaning: 55,
  Electrical: 110,
  Gardening: 65,
  Handyman: 75,
  Painting: 70,
  Plumbing: 105,
};

const roundMoney = (value) => Math.round(value / 5) * 5;

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function inferHours(description = '') {
  const text = description.toLowerCase();
  if (/\b(full|entire|renovat|rewir|remodel|replace all|whole)\b/.test(text)) return 8;
  if (/\b(install|replace|repair|paint|clean|garden|service)\b/.test(text)) return 3;
  if (/\b(small|minor|tap|faucet|outlet|switch|inspect|diagnos|quote)\b/.test(text)) return 1.5;
  return 2;
}

function buildEstimate({ trade, rates = [], durationHours, description = '' }) {
  const validRates = rates
    .map(Number)
    .filter((rate) => Number.isFinite(rate) && rate >= 30 && rate <= 400);
  const requestedHours = Number(durationHours);
  const typicalHours = Number.isFinite(requestedHours) && requestedHours > 0
    ? Math.min(requestedHours, 24)
    : inferHours(description);
  const hoursLow = Math.max(0.5, Math.round(typicalHours * 0.75 * 2) / 2);
  const hoursHigh = Math.min(24, Math.max(hoursLow, Math.round(typicalHours * 1.5 * 2) / 2));

  const baseline = BASELINE_RATES[trade] || 80;
  const rateLow = validRates.length > 1
    ? percentile(validRates, 0.25)
    : validRates.length === 1 ? validRates[0] * 0.85 : baseline * 0.85;
  const rateHigh = validRates.length > 1
    ? percentile(validRates, 0.75)
    : validRates.length === 1 ? validRates[0] * 1.15 : baseline * 1.15;

  return {
    currency: 'AUD',
    low: roundMoney(calculatePricing(rateLow, hoursLow).homeownerPays),
    high: roundMoney(calculatePricing(rateHigh, hoursHigh).homeownerPays),
    hours: { low: hoursLow, high: hoursHigh },
    hourlyRate: { low: roundMoney(rateLow), high: roundMoney(rateHigh) },
    sampleSize: validRates.length,
    source: validRates.length ? 'marketplace' : 'baseline',
    includesServiceFee: true,
    disclaimer: 'Guide only. The tradie confirms the final scope and price before work starts.',
  };
}

module.exports = { buildEstimate, inferHours };
