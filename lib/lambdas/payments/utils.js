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
      'Access-Control-Allow-Origin': '*',
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
 * Extract user ID from API Gateway event (from Cognito authorizer context)
 */
function getUserId(event) {
  const claims = event.requestContext?.authorizer?.claims;
  return claims?.['custom:userId'] || claims?.sub;
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
  now,
  nowMs,
  getQueryParam,
  getPathParam,
  getBody,
  isTradie,
  isHomeowner,
};
