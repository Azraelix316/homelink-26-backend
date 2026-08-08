const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, now } = require('../utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const USERS_TABLE = process.env.USERS_TABLE;
const PROFILES_TABLE = process.env.PROFILES_TABLE;
const REVIEWS_TABLE = process.env.REVIEWS_TABLE;

/**
 * GET /profiles/tradie/{tradieId}
 * Get tradie profile with stats
 */
async function getTradieProfile(event) {
  try {
    const tradieId = getPathParam(event, 'tradieId');
    if (!tradieId) {
      return errorResponse(400, 'tradieId required');
    }

    // Get user record
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId: tradieId },
    }).promise();

    if (!userResult.Item || userResult.Item.role !== 'tradie') {
      return errorResponse(404, 'Tradie not found');
    }

    const user = userResult.Item;

    // Get tradie profile (extended info)
    const profileResult = await dynamodb.get({
      TableName: PROFILES_TABLE,
      Key: { tradieId },
    }).promise();

    const profile = profileResult.Item || {};

    // Get reviews and calculate rating
    const reviewsResult = await dynamodb.query({
      TableName: REVIEWS_TABLE,
      IndexName: 'TradieIdIndex',
      KeyConditionExpression: 'tradieId = :tradieId',
      ExpressionAttributeValues: { ':tradieId': tradieId },
    }).promise();

    const reviews = reviewsResult.Items || [];
    const averageRating = reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
      : 0;

    return response(200, {
      tradieId,
      name: user.name,
      email: user.email,
      hourlyRate: user.hourlyRate,
      location: user.location,
      trade: user.trade || 'General',
      yearsExperience: user.yearsExperience || 0,
      bio: user.bio || '',
      serviceTypes: user.serviceTypes || [],
      photoGallery: user.photoGallery || [],
      rating: parseFloat(averageRating),
      reviewCount: reviews.length,
      reviews: reviews.slice(0, 10), // Return last 10 reviews
    });
  } catch (error) {
    console.error('Get tradie profile error:', error);
    return errorResponse(500, 'Failed to fetch tradie profile');
  }
}

/**
 * GET /profiles/homeowner/{homeownerId}
 * Get homeowner profile
 */
async function getHomeownerProfile(event) {
  try {
    const homeownerId = getPathParam(event, 'homeownerId');
    if (!homeownerId) {
      return errorResponse(400, 'homeownerId required');
    }

    const result = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId: homeownerId },
    }).promise();

    if (!result.Item || result.Item.role !== 'homeowner') {
      return errorResponse(404, 'Homeowner not found');
    }

    const user = result.Item;
    return response(200, {
      homeownerId,
      name: user.name,
      email: user.email,
      location: user.location,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Get homeowner profile error:', error);
    return errorResponse(500, 'Failed to fetch homeowner profile');
  }
}

/**
 * PATCH /profiles/me
 * Update current user profile
 */
async function updateProfile(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);

    // Get current user to determine role
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId },
    }).promise();

    if (!userResult.Item) {
      return errorResponse(404, 'User not found');
    }

    const user = userResult.Item;
    const role = user.role;

    // Build update expression
    const updateFields = {};
    const expressionAttributeNames = { '#ua': 'updatedAt' };
    const expressionAttributeValues = { ':ua': now() };
    let updateExpressions = ['#ua = :ua'];

    // Common fields
    if (body.name) {
      updateFields.name = body.name;
      expressionAttributeValues[':name'] = body.name;
      updateExpressions.push('#n = :name');
      expressionAttributeNames['#n'] = 'name';
    }

    if (body.location !== undefined) {
      updateFields.location = body.location;
      expressionAttributeValues[':location'] = body.location;
      updateExpressions.push('location = :location');
    }

    // Tradie-specific fields
    if (role === 'tradie') {
      if (body.hourlyRate !== undefined) {
        updateFields.hourlyRate = parseFloat(body.hourlyRate);
        expressionAttributeValues[':rate'] = parseFloat(body.hourlyRate);
        updateExpressions.push('hourlyRate = :rate');
      }

      if (body.bio !== undefined) {
        updateFields.bio = body.bio;
        expressionAttributeValues[':bio'] = body.bio;
        updateExpressions.push('bio = :bio');
      }

      if (body.trade !== undefined) {
        updateFields.trade = body.trade;
        expressionAttributeValues[':trade'] = body.trade;
        updateExpressions.push('trade = :trade');
      }

      if (body.yearsExperience !== undefined) {
        updateFields.yearsExperience = parseInt(body.yearsExperience);
        expressionAttributeValues[':yrs'] = parseInt(body.yearsExperience);
        updateExpressions.push('yearsExperience = :yrs');
      }

      if (body.serviceTypes) {
        updateFields.serviceTypes = body.serviceTypes;
        expressionAttributeValues[':services'] = body.serviceTypes;
        updateExpressions.push('serviceTypes = :services');
      }

      if (body.photoGallery) {
        updateFields.photoGallery = body.photoGallery;
        expressionAttributeValues[':photos'] = body.photoGallery;
        updateExpressions.push('photoGallery = :photos');
      }

      // Update tradie profile table
      await dynamodb.put({
        TableName: PROFILES_TABLE,
        Item: {
          tradieId: userId,
          ...updateFields,
          updatedAt: now(),
        },
      }).promise();
    }

    // Update user record
    await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: updateExpressions.join(', '),
      ExpressionAttributeNames,
      ExpressionAttributeValues,
    }).promise();

    // Return updated user
    const updated = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId },
    }).promise();

    return response(200, updated.Item);
  } catch (error) {
    console.error('Update profile error:', error);
    return errorResponse(500, 'Failed to update profile');
  }
}

/**
 * POST /profiles/tradie
 * Register as tradie (during onboarding)
 */
async function registerTradie(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const body = getBody(event);
    const { trade, yearsExperience, serviceTypes, hourlyRate } = body;

    if (!trade || hourlyRate === undefined) {
      return errorResponse(400, 'Missing required fields: trade, hourlyRate');
    }

    // Create tradie profile
    await dynamodb.put({
      TableName: PROFILES_TABLE,
      Item: {
        tradieId: userId,
        trade,
        yearsExperience: parseInt(yearsExperience) || 0,
        serviceTypes: serviceTypes || [],
        hourlyRate: parseFloat(hourlyRate),
        bio: body.bio || '',
        photoGallery: [],
        createdAt: now(),
        updatedAt: now(),
      },
    }).promise();

    // Update user record
    await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET trade = :trade, hourlyRate = :rate, yearsExperience = :yrs, updatedAt = :ua',
      ExpressionAttributeValues: {
        ':trade': trade,
        ':rate': parseFloat(hourlyRate),
        ':yrs': parseInt(yearsExperience) || 0,
        ':ua': now(),
      },
    }).promise();

    const result = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { userId },
    }).promise();

    return response(201, result.Item);
  } catch (error) {
    console.error('Register tradie error:', error);
    return errorResponse(500, 'Failed to register as tradie');
  }
}

module.exports = {
  getTradieProfile,
  getHomeownerProfile,
  updateProfile,
  registerTradie,
};
