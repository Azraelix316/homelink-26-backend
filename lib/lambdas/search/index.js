const AWS = require('aws-sdk');
const { response, errorResponse, getQueryParam } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const PROFILES_TABLE = process.env.PROFILES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const REVIEWS_TABLE = process.env.REVIEWS_TABLE;

/**
 * GET /search?trade={type}&location={suburb}&free={date}&rating_min={4.0|4.5|4.8}
 * Search for tradies with filters
 */
async function searchTradies(event) {
  try {
    const trade = getQueryParam(event, 'trade');
    const location = getQueryParam(event, 'location');
    const ratingMin = parseFloat(getQueryParam(event, 'rating_min') || '0');

    // Start with all tradies
    let result = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: '#role = :role',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'tradie' },
    }).promise();

    let tradies = result.Items || [];

    // Get profiles for additional filtering
    const profileResult = await dynamodb.scan({
      TableName: PROFILES_TABLE,
    }).promise();

    const profiles = profileResult.Items || [];
    const profileMap = {};
    profiles.forEach(p => {
      profileMap[p.tradieId] = p;
    });

    const reviewsResult = await dynamodb.scan({ TableName: REVIEWS_TABLE }).promise();
    const ratingMap = {};
    (reviewsResult.Items || []).forEach(review => {
      const stats = ratingMap[review.tradieId] || { total: 0, count: 0 };
      stats.total += Number(review.rating) || 0;
      stats.count += 1;
      ratingMap[review.tradieId] = stats;
    });

    // Apply filters
    tradies = tradies.filter(tradie => {
      const profile = profileMap[tradie.userId] || {};
      const tradieTrade = tradie.trade || profile.trade || '';
      const tradieLocation = tradie.location || profile.location || '';

      // A requested filter must match; missing data is not a match.
      if (trade && tradieTrade.toLowerCase() !== trade.toLowerCase()) {
        return false;
      }

      if (location && tradieLocation.toLowerCase() !== location.toLowerCase()) {
        return false;
      }

      // Filter by the source-of-truth reviews rather than a stale profile field.
      const stats = ratingMap[tradie.userId];
      const rating = stats?.count ? stats.total / stats.count : 0;
      if (rating < ratingMin) {
        return false;
      }

      return true;
    });

    // Enrich with profile data
    const enriched = tradies.map(tradie => {
      const profile = profileMap[tradie.userId] || {};
      const stats = ratingMap[tradie.userId];
      const rating = stats?.count ? Number((stats.total / stats.count).toFixed(1)) : 0;
      return {
        tradieId: tradie.userId,
        name: tradie.name,
        email: tradie.email,
        location: tradie.location,
        hourlyRate: tradie.hourlyRate,
        trade: tradie.trade || profile.trade,
        yearsExperience: tradie.yearsExperience || profile.yearsExperience || 0,
        bio: tradie.bio || profile.bio || '',
        rating,
        reviewCount: stats?.count || 0,
        serviceTypes: profile.serviceTypes || [],
      };
    });

    // Sort by rating (descending)
    enriched.sort((a, b) => b.rating - a.rating);

    return response(200, {
      filters: {
        trade,
        location,
        ratingMin,
      },
      tradies: enriched,
      count: enriched.length,
    });
  } catch (error) {
    console.error('Search tradies error:', error);
    return errorResponse(500, 'Failed to search tradies');
  }
}

/**
 * GET /trades
 * Get list of available trade types
 */
async function getTrades(event) {
  try {
    // Scan all tradie profiles to get unique trades
    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: '#role = :role',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'tradie' },
      ProjectionExpression: 'trade',
    }).promise();

    const trades = new Set();
    (result.Items || []).forEach(item => {
      if (item.trade) {
        trades.add(item.trade);
      }
    });

    return response(200, {
      trades: Array.from(trades).sort(),
      count: trades.size,
    });
  } catch (error) {
    console.error('Get trades error:', error);
    return errorResponse(500, 'Failed to fetch trades');
  }
}

/**
 * GET /locations
 * Get list of available locations
 */
async function getLocations(event) {
  try {
    // Scan all users to get unique locations
    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: 'attribute_exists(location)',
      ProjectionExpression: '#location',
      ExpressionAttributeNames: { '#location': 'location' },
    }).promise();

    const locations = new Set();
    (result.Items || []).forEach(item => {
      if (item.location) {
        locations.add(item.location);
      }
    });

    return response(200, {
      locations: Array.from(locations).sort(),
      count: locations.size,
    });
  } catch (error) {
    console.error('Get locations error:', error);
    return errorResponse(500, 'Failed to fetch locations');
  }
}

module.exports = {
  searchTradies,
  getTrades,
  getLocations,
};
