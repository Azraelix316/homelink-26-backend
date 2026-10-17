const crypto = require('crypto');

/**
 * Generate UUID for primary keys
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Standard API Gateway response formatter
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Error response formatter
 */
function errorResponse(statusCode, message) {
  return response(statusCode, { error: message });
}

/**
 * Parse JWT token (basic parsing, validation done by Cognito authorizer)
 */
function parseToken(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Extract user ID from API Gateway event (from Cognito authorizer context).
 * User records are keyed by the immutable custom:userId attribute set at
 * registration, not the Cognito sub.
 */
function getUserId(event) {
  const claims = event.requestContext?.authorizer?.claims;
  return claims?.['custom:userId'] || claims?.sub;
}

/**
 * Get the caller's role from their (Cognito-verified) token claims
 */
function getUserRole(event) {
  return event.requestContext?.authorizer?.claims?.['custom:role'];
}

/**
 * Get current timestamp in seconds
 */
function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get current timestamp in milliseconds
 */
function nowMs() {
  return Date.now();
}

/**
 * Parse query string parameters
 */
function getQueryParam(event, key, defaultValue = undefined) {
  const params = event.queryStringParameters || {};
  return params[key] !== undefined ? params[key] : defaultValue;
}

/**
 * Parse path parameters
 */
function getPathParam(event, key) {
  return event.pathParameters?.[key];
}

/**
 * Parse request body
 */
function getBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {};
  }
}

/**
 * Clamp a page-size query parameter to 1..max
 */
function getLimit(event, defaultValue, max = 100) {
  const limit = parseInt(getQueryParam(event, 'limit', String(defaultValue)), 10);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : defaultValue;
}

/**
 * YYYY-MM-DD that is a real calendar date
 */
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * HH:MM in 24-hour time
 */
function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * Optional string field no longer than max characters
 */
function isOptionalString(value, max) {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

/**
 * Parse an hourly rate in dollars; returns null unless 1..1000
 */
function parseHourlyRate(value) {
  const rate = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(rate) && rate >= 1 && rate <= 1000 ? Math.round(rate * 100) / 100 : null;
}

/**
 * Check if user is tradie based on custom attributes
 */
function isTradie(claims) {
  return claims?.['custom:role'] === 'tradie';
}

/**
 * Check if user is homeowner
 */
function isHomeowner(claims) {
  return claims?.['custom:role'] === 'homeowner';
}

module.exports = {
  generateId,
  response,
  errorResponse,
  parseToken,
  getUserId,
  getUserRole,
  getLimit,
  isValidDate,
  isValidTime,
  isOptionalString,
  parseHourlyRate,
  now,
  nowMs,
  getQueryParam,
  getPathParam,
  getBody,
  isTradie,
  isHomeowner,
};
