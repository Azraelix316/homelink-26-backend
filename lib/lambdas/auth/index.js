const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, now, generateId } = require('./utils');

const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

/**
 * POST /auth/register
 * Register a new user (tradie or homeowner)
 * Body: { email, password, role, name, location?, hourlyRate?, trade? }
 */
async function register(event) {
  try {
    const body = getBody(event);
    const { email, password, role, name, location, hourlyRate, trade } = body;

    // Validate required fields
    if (!email || !password || !role || !name) {
      return errorResponse(400, 'Missing required fields: email, password, role, name');
    }

    if (!['tradie', 'homeowner'].includes(role)) {
      return errorResponse(400, 'Invalid role. Must be tradie or homeowner');
    }

    const parsedHourlyRate = Number(hourlyRate);
    if (role === 'tradie' && (!Number.isFinite(parsedHourlyRate) || parsedHourlyRate <= 0)) {
      return errorResponse(400, 'A valid hourly rate is required for tradie registration');
    }

    if (role === 'tradie' && (!trade || !String(trade).trim())) {
      return errorResponse(400, 'Trade is required for tradie registration');
    }

    // Create Cognito user
    const userId = generateId();
    try {
      await cognito.adminCreateUser({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: name },
          { Name: 'custom:role', Value: role },
          { Name: 'custom:userId', Value: userId },
        ],
      }).promise();

      // Set permanent password
      await cognito.adminSetUserPassword({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }).promise();
    } catch (cognitoError) {
      if (cognitoError.code === 'UsernameExistsException') {
        return errorResponse(409, 'Email already registered');
      }
      console.error('Cognito error:', cognitoError);
      return errorResponse(500, 'Failed to create Cognito user');
    }

    // Create user record in DynamoDB
    const userRecord = {
      userId,
      email,
      name,
      role,
      location: location || '',
      createdAt: now(),
      updatedAt: now(),
    };

    if (role === 'tradie') {
      userRecord.hourlyRate = parsedHourlyRate;
      userRecord.rating = 0;
      userRecord.reviewCount = 0;
      userRecord.trade = String(trade).trim();
      userRecord.yearsExperience = 0;
      userRecord.bio = '';
      userRecord.serviceTypes = [];
      userRecord.photoGallery = [];
      userRecord.averageRating = 0;
    }

    await dynamodb.put({
      TableName: process.env.USERS_TABLE,
      Item: userRecord,
    }).promise();

    return response(201, {
      userId,
      email,
      name,
      role,
      message: 'User registered successfully',
    });
  } catch (error) {
    console.error('Register error:', error);
    return errorResponse(500, 'Failed to register user');
  }
}

/**
 * POST /auth/login
 * Authenticate user
 * Body: { email, password }
 */
async function login(event) {
  try {
    const body = getBody(event);
    const { email, password } = body;

    if (!email || !password) {
      return errorResponse(400, 'Email and password required');
    }

    try {
      const authResult = await cognito.adminInitiateAuth({
        UserPoolId: process.env.USER_POOL_ID,
        ClientId: process.env.CLIENT_ID,
        AuthFlow: 'ADMIN_NO_SRP_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }).promise();

      const { AuthenticationResult } = authResult;
      const decoded = decodeToken(AuthenticationResult.IdToken);

      return response(200, {
        accessToken: AuthenticationResult.AccessToken,
        idToken: AuthenticationResult.IdToken,
        refreshToken: AuthenticationResult.RefreshToken,
        expiresIn: AuthenticationResult.ExpiresIn,
        user: {
          userId: decoded['custom:userId'],
          email: decoded.email,
          name: decoded.name,
          role: decoded['custom:role'],
        },
      });
    } catch (cognitoError) {
      if (cognitoError.code === 'UserNotFoundException' || cognitoError.code === 'NotAuthorizedException') {
        return errorResponse(401, 'Invalid email or password');
      }
      console.error('Cognito auth error:', cognitoError);
      return errorResponse(500, 'Authentication failed');
    }
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse(500, 'Login failed');
  }
}

/**
 * GET /auth/me
 * Get current user profile
 */
async function getMe(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const result = await dynamodb.get({
      TableName: process.env.USERS_TABLE,
      Key: { userId },
    }).promise();

    if (!result.Item) {
      return errorResponse(404, 'User not found');
    }

    return response(200, result.Item);
  } catch (error) {
    console.error('Get me error:', error);
    return errorResponse(500, 'Failed to fetch user');
  }
}

/**
 * POST /auth/logout
 * Logout user (invalidate token in Cognito)
 */
async function logout(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    // In a real app, you'd invalidate the token in Cognito
    // For now, just return success - token expiration is handled client-side
    return response(200, { message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    return errorResponse(500, 'Logout failed');
  }
}

/**
 * Simple JWT decode (no signature verification - Cognito authorizer handles that)
 */
function decodeToken(token) {
  try {
    const parts = token.split('.');
    const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    return {};
  }
}

module.exports = { register, login, getMe, logout };
