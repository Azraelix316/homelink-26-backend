const crypto = require('crypto');
const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, now, generateId, isOptionalString, parseHourlyRate } = require('./utils');

const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

/**
 * The registration app client has a secret so that only this backend can sign
 * users up with custom:role and custom:userId. The secret is read from Cognito
 * once per container rather than stored in the Lambda environment.
 */
let clientSecretPromise;
function getRegistrationClientSecret() {
  if (!clientSecretPromise) {
    clientSecretPromise = cognito.describeUserPoolClient({
      UserPoolId: process.env.USER_POOL_ID,
      ClientId: process.env.REGISTRATION_CLIENT_ID,
    }).promise()
      .then(result => result.UserPoolClient.ClientSecret)
      .catch(error => {
        clientSecretPromise = undefined;
        throw error;
      });
  }
  return clientSecretPromise;
}

async function secretHash(username) {
  const secret = await getRegistrationClientSecret();
  return crypto.createHmac('sha256', secret)
    .update(username + process.env.REGISTRATION_CLIENT_ID)
    .digest('base64');
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAttribute(user, name) {
  const attribute = (user.UserAttributes || []).find(a => a.Name === name);
  return attribute ? attribute.Value : undefined;
}

async function signUp(email, password, name, role, userId) {
  return cognito.signUp({
    ClientId: process.env.REGISTRATION_CLIENT_ID,
    SecretHash: await secretHash(email),
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: name },
      { Name: 'custom:role', Value: role },
      { Name: 'custom:userId', Value: userId },
    ],
  }).promise();
}

/**
 * Removes a registration that was never confirmed so the address can be
 * registered again. Without this, anyone could block an email address by
 * registering it first. Returns false if the existing account is confirmed.
 */
async function removeUnconfirmedUser(email) {
  const existing = await cognito.adminGetUser({
    UserPoolId: process.env.USER_POOL_ID,
    Username: email,
  }).promise();

  if (existing.UserStatus !== 'UNCONFIRMED') {
    return false;
  }

  await cognito.adminDeleteUser({
    UserPoolId: process.env.USER_POOL_ID,
    Username: email,
  }).promise();

  const oldUserId = getAttribute(existing, 'custom:userId');
  if (oldUserId) {
    await dynamodb.delete({
      TableName: process.env.USERS_TABLE,
      Key: { userId: oldUserId },
    }).promise();
  }
  return true;
}

/**
 * POST /auth/register
 * Register a new user (tradie or homeowner). Cognito emails a verification
 * code; the account cannot log in until it is confirmed via /auth/confirm.
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

    if (!isValidEmail(email)) {
      return errorResponse(400, 'Invalid email address');
    }

    if (typeof password !== 'string' || password.length > 256) {
      return errorResponse(400, 'Invalid password');
    }

    if (typeof name !== 'string' || name.length > 100 || !isOptionalString(location, 100)) {
      return errorResponse(400, 'name and location must be text of at most 100 characters');
    }

    if (role === 'tradie' && parseHourlyRate(hourlyRate) === null) {
      return errorResponse(400, 'hourlyRate between 1 and 1000 required for tradie registration');
    }

    // Create the Cognito user. It stays UNCONFIRMED (and cannot log in)
    // until the emailed code is confirmed.
    const userId = generateId();
    let signUpResult;
    try {
      try {
        signUpResult = await signUp(email, password, name, role, userId);
      } catch (error) {
        if (error.code !== 'UsernameExistsException' || !(await removeUnconfirmedUser(email))) {
          throw error;
        }
        signUpResult = await signUp(email, password, name, role, userId);
      }
    } catch (cognitoError) {
      if (cognitoError.code === 'UsernameExistsException') {
        return errorResponse(409, 'Email already registered');
      }
      if (cognitoError.code === 'InvalidPasswordException') {
        return errorResponse(400, 'Password must be at least 8 characters and include a lowercase letter and a digit');
      }
      if (cognitoError.code === 'LimitExceededException' || cognitoError.code === 'TooManyRequestsException') {
        return errorResponse(429, 'Too many attempts. Please try again later');
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
      emailVerified: false,
      createdAt: now(),
      updatedAt: now(),
    };

    if (role === 'tradie') {
      userRecord.hourlyRate = parseHourlyRate(hourlyRate);
      userRecord.rating = 0;
      userRecord.reviewCount = 0;
      userRecord.trade = 'General';
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

    const delivery = signUpResult.CodeDeliveryDetails || {};
    return response(201, {
      userId,
      email,
      name,
      role,
      emailVerified: false,
      codeDeliveryDestination: delivery.Destination,
      message: 'Registration started. Enter the verification code sent to your email to activate your account.',
    });
  } catch (error) {
    console.error('Register error:', error);
    return errorResponse(500, 'Failed to register user');
  }
}

/**
 * POST /auth/confirm
 * Confirm a registration with the code Cognito emailed
 * Body: { email, code }
 */
async function confirmRegistration(event) {
  try {
    const { email, code } = getBody(event);

    if (!isValidEmail(email) || typeof code !== 'string' || !/^\d{4,10}$/.test(code)) {
      return errorResponse(400, 'A valid email and numeric code are required');
    }

    try {
      await cognito.confirmSignUp({
        ClientId: process.env.REGISTRATION_CLIENT_ID,
        SecretHash: await secretHash(email),
        Username: email,
        ConfirmationCode: code,
      }).promise();
    } catch (cognitoError) {
      if (['CodeMismatchException', 'ExpiredCodeException', 'UserNotFoundException'].includes(cognitoError.code)) {
        return errorResponse(400, 'Invalid or expired verification code');
      }
      if (cognitoError.code === 'NotAuthorizedException') {
        return errorResponse(409, 'Account is already confirmed');
      }
      if (cognitoError.code === 'LimitExceededException' || cognitoError.code === 'TooManyFailedAttemptsException') {
        return errorResponse(429, 'Too many attempts. Please try again later');
      }
      console.error('Cognito confirm error:', cognitoError);
      return errorResponse(500, 'Failed to confirm registration');
    }

    const user = await cognito.adminGetUser({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
    }).promise();
    const userId = getAttribute(user, 'custom:userId');

    if (userId) {
      await dynamodb.update({
        TableName: process.env.USERS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET emailVerified = :true, updatedAt = :now',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: { ':true': true, ':now': now() },
      }).promise();
    }

    return response(200, { email, emailVerified: true, message: 'Email verified. You can now log in.' });
  } catch (error) {
    console.error('Confirm error:', error);
    return errorResponse(500, 'Failed to confirm registration');
  }
}

/**
 * POST /auth/resend-code
 * Email a new verification code for an unconfirmed registration
 * Body: { email }
 */
async function resendConfirmationCode(event) {
  try {
    const { email } = getBody(event);

    if (!isValidEmail(email)) {
      return errorResponse(400, 'Invalid email address');
    }

    try {
      await cognito.resendConfirmationCode({
        ClientId: process.env.REGISTRATION_CLIENT_ID,
        SecretHash: await secretHash(email),
        Username: email,
      }).promise();
    } catch (cognitoError) {
      if (cognitoError.code === 'LimitExceededException' || cognitoError.code === 'TooManyRequestsException') {
        return errorResponse(429, 'Too many attempts. Please try again later');
      }
      // Unknown or already-confirmed addresses get the same answer, so this
      // endpoint can't be used to find out which emails are registered.
      if (!['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(cognitoError.code)) {
        console.error('Cognito resend error:', cognitoError);
        return errorResponse(500, 'Failed to resend verification code');
      }
    }

    return response(200, { message: 'If that account is awaiting verification, a new code has been sent.' });
  } catch (error) {
    console.error('Resend code error:', error);
    return errorResponse(500, 'Failed to resend verification code');
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
      if (cognitoError.code === 'UserNotConfirmedException') {
        return response(403, {
          error: 'Email address not verified. Enter the code sent to your email, or request a new one.',
          code: 'EMAIL_NOT_VERIFIED',
        });
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

module.exports = { register, confirmRegistration, resendConfirmationCode, login, getMe, logout };
