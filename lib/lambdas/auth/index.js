const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, now, generateId } = require('./utils');

const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const dynamodb = new AWS.DynamoDB({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const USERS_TABLE = process.env.USERS_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;

/**
 * POST /auth/register
 * Register a new user (tradie or homeowner)
 * Body: { email, password, role, name, location?, hourlyRate? }
 */
async function register(event) {
  try {
    const body = getBody(event);
    const { email, password, role, name, location, hourlyRate } = body;

    // Validate required fields
    if (!email || !password || !role || !name) {
      return errorResponse(400, 'Missing required fields: email, password, role, name');
    }

    if (!['tradie', 'homeowner'].includes(role)) {
      return errorResponse(400, 'Invalid role. Must be tradie or homeowner');
    }

    if (role === 'tradie' && !hourlyRate) {
      return errorResponse(400, 'hourlyRate required for tradie registration');
    }

    // Create Cognito user
    const userId = generateId();
    try {
      await cognito.send(new AdminCreateUserCommand({
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
      }));

      // Set permanent password
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }));
    } catch (cognitoError) {
      if (cognitoError.name === 'UsernameExistsException') {
        return errorResponse(409, 'Email already registered');
      }
      console.error('Cognito error:', cognitoError);
      return errorResponse(500, 'Failed to create Cognito user');
    }

    // Create user record in DynamoDB
    const userRecord = {
      userId: { S: userId },
      email: { S: email },
      name: { S: name },
      role: { S: role },
      location: { S: location || '' },
      createdAt: { S: now() },
      updatedAt: { S: now() },
    };

    if (role === 'tradie') {
      userRecord.hourlyRate = { N: parseFloat(hourlyRate).toString() };
      userRecord.rating = { N: '0' };
      userRecord.reviewCount = { N: '0' };
      userRecord.trade = { S: 'General' };
      userRecord.yearsExperience = { N: '0' };
      userRecord.bio = { S: '' };
      userRecord.serviceTypes = { L: [] };
      userRecord.photoGallery = { L: [] };
      userRecord.averageRating = { N: '0' };
    }

    await dynamodb.send(new PutCommand({
      TableName: process.env.USERS_TABLE,
      Item: userRecord,
    }));

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
      const authResult = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID,
        ClientId: process.env.CLIENT_ID,
        AuthFlow: 'ADMIN_NO_SRP_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }));

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
      if (cognitoError.name === 'UserNotFoundException' || cognitoError.name === 'NotAuthorizedException') {
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

    const result = await dynamodb.send(new GetCommand({
      TableName: process.env.USERS_TABLE,
      Key: { userId: { S: userId } },
    }));

    if (!result.Item) {
      return errorResponse(404, 'User not found');
    }

    // Convert DynamoDB format to plain object
    const user = convertFromDynamoDB(result.Item);
    return response(200, user);
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

/**
 * Convert DynamoDB AttributeValue format to plain JavaScript object
 */
function convertFromDynamoDB(item) {
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) result[key] = value.S;
    else if (value.N !== undefined) result[key] = parseFloat(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.NULL !== undefined) result[key] = null;
    else if (value.L !== undefined) result[key] = value.L.map(convertFromDynamoDB);
    else if (value.M !== undefined) result[key] = convertFromDynamoDB(value.M);
    else result[key] = value;
  }
  return result;
}

module.exports = { register, login, getMe, logout };

