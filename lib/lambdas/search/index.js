const AWS = require('aws-sdk');
const { response, errorResponse, getQueryParam } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const PROFILES_TABLE = process.env.PROFILES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

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
      // Records from before email verification have no emailVerified flag
      FilterExpression: '#role = :role AND (attribute_not_exists(emailVerified) OR emailVerified = :verified)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'tradie', ':verified': true },
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

    // Apply filters
    tradies = tradies.filter(tradie => {
      const profile = profileMap[tradie.userId];

      // Filter by trade
      if (trade && tradie.trade && tradie.trade.toLowerCase() !== trade.toLowerCase()) {
        return false;
      }

      // Filter by location
      if (location && tradie.location && tradie.location.toLowerCase() !== location.toLowerCase()) {
        return false;
      }

      // Filter by rating
      if (profile && profile.rating < ratingMin) {
        return false;
      }

      return true;
    });

    // Enrich with profile data
    const enriched = tradies.map(tradie => {
      const profile = profileMap[tradie.userId] || {};
      return {
        tradieId: tradie.userId,
        name: tradie.name,
        location: tradie.location,
        hourlyRate: tradie.hourlyRate,
        trade: tradie.trade || profile.trade,
        yearsExperience: tradie.yearsExperience || profile.yearsExperience || 0,
        bio: tradie.bio || profile.bio || '',
        rating: profile.rating || 0,
        reviewCount: profile.reviewCount || 0,
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
      // Records from before email verification have no emailVerified flag
      FilterExpression: '#role = :role AND (attribute_not_exists(emailVerified) OR emailVerified = :verified)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'tradie', ':verified': true },
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
      ProjectionExpression: 'location',
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
