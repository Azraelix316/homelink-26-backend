const crypto = require('crypto');

/**
 * Generate UUID for primary keys
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Origins allowed to call the API from a browser or app webview
 * (comma-separated ALLOWED_ORIGINS; '*' allows any)
 */
function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

/**
 * Case-insensitive request header lookup
 */
function getHeader(event, name) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/**
 * CORS headers for a request: echoes the request's Origin when it is allowed,
 * so the web app, the Capacitor apps and staging can all call the API
 */
function corsHeaders(event) {
  const allowed = getAllowedOrigins();
  if (allowed.includes('*')) {
    return { 'Access-Control-Allow-Origin': '*', Vary: 'Origin' };
  }
  const origin = getHeader(event, 'origin');
  return origin && allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : { Vary: 'Origin' };
}

/**
 * Standard API Gateway response formatter. The per-request CORS origin is
 * filled in by withCors.
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(null),
    },
    body: JSON.stringify(body),
  };
}

/**
 * Wrap a module's API handlers so every response carries the CORS headers
 * for the calling origin
 */
function withCors(handlers) {
  const wrapped = {};
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (event, ...rest) => {
      const result = await handler(event, ...rest);
      if (!result || typeof result.statusCode !== 'number') return result;
      return { ...result, headers: { ...result.headers, ...corsHeaders(event) } };
    };
  }
  return wrapped;
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
 * Finite number within min..max (inclusive)
 */
function isNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
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
  getAllowedOrigins,
  getHeader,
  corsHeaders,
  response,
  withCors,
  errorResponse,
  parseToken,
  getUserId,
  getUserRole,
  getLimit,
  isValidDate,
  isValidTime,
  isOptionalString,
  isNumberInRange,
  parseHourlyRate,
  now,
  nowMs,
  getQueryParam,
  getPathParam,
  getBody,
  isTradie,
  isHomeowner,
};
