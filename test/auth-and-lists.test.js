// Login, /auth/me, tradie registration, the bookings list and pricing endpoints,
// with Cognito and DynamoDB mocked

const ok = value => ({ promise: () => Promise.resolve(value) });
const fail = code => ({ promise: () => Promise.reject(Object.assign(new Error(code), { code })) });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(), query: jest.fn() };
const mockCognito = {
  describeUserPoolClient: jest.fn(),
  signUp: jest.fn(),
  adminGetUser: jest.fn(),
  adminDeleteUser: jest.fn(),
  adminInitiateAuth: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  CognitoIdentityServiceProvider: jest.fn(() => mockCognito),
}));

Object.assign(process.env, {
  USERS_TABLE: 'users',
  BOOKINGS_TABLE: 'bookings',
  USER_POOL_ID: 'pool-1',
  CLIENT_ID: 'public-client',
  REGISTRATION_CLIENT_ID: 'registration-client',
});

const auth = require('../lib/lambdas/auth');
const bookings = require('../lib/lambdas/bookings');
const pricing = require('../lib/lambdas/pricing');

const post = body => ({ body: JSON.stringify(body) });
const signedIn = (userId, extra = {}) => ({ requestContext: { authorizer: { claims: { 'custom:userId': userId } } }, ...extra });
const bodyOf = res => JSON.parse(res.body);
const jwt = claims => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.put.mockReturnValue(ok({}));
  mockCognito.describeUserPoolClient.mockReturnValue(ok({ UserPoolClient: { ClientSecret: 'secret' } }));
  mockCognito.signUp.mockReturnValue(ok({ UserConfirmed: false, CodeDeliveryDetails: { Destination: 't***@e***' } }));
});

describe('login', () => {
  test('returns the tokens and the user from the ID token', async () => {
    const idToken = jwt({ 'custom:userId': 'u1', email: 'jo@example.com', name: 'Jo', 'custom:role': 'tradie' });
    mockCognito.adminInitiateAuth.mockReturnValue(ok({
      AuthenticationResult: { IdToken: idToken, AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 },
    }));

    const res = await auth.login(post({ email: 'jo@example.com', password: 'Passw0rd!' }));

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      idToken, accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
      user: { userId: 'u1', email: 'jo@example.com', name: 'Jo', role: 'tradie' },
    });
    expect(mockCognito.adminInitiateAuth.mock.calls[0][0]).toMatchObject({
      ClientId: 'public-client', AuthFlow: 'ADMIN_NO_SRP_AUTH',
    });
  });

  test.each([['UserNotFoundException'], ['NotAuthorizedException']])(
    '%s gives the same 401, so accounts cannot be enumerated',
    async (code) => {
      mockCognito.adminInitiateAuth.mockReturnValue(fail(code));

      const res = await auth.login(post({ email: 'jo@example.com', password: 'wrong' }));

      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).error).toBe('Invalid email or password');
    }
  );

  test('other Cognito failures are a 500 without leaking details', async () => {
    mockCognito.adminInitiateAuth.mockReturnValue(fail('InternalErrorException'));

    const res = await auth.login(post({ email: 'jo@example.com', password: 'Passw0rd!' }));

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('InternalErrorException');
  });

  test('missing fields are a 400 without calling Cognito', async () => {
    const res = await auth.login(post({ email: 'jo@example.com' }));

    expect(res.statusCode).toBe(400);
    expect(mockCognito.adminInitiateAuth).not.toHaveBeenCalled();
  });
});

describe('session refresh', () => {
  test('a valid refresh token gets new ID and access tokens', async () => {
    mockCognito.adminInitiateAuth.mockReturnValue(ok({
      AuthenticationResult: { IdToken: 'new-id', AccessToken: 'new-access', ExpiresIn: 3600 },
    }));

    const res = await auth.refreshSession(post({ refreshToken: 'refresh-1' }));

    expect(bodyOf(res)).toEqual({ idToken: 'new-id', accessToken: 'new-access', expiresIn: 3600 });
    expect(mockCognito.adminInitiateAuth.mock.calls[0][0]).toEqual({
      UserPoolId: 'pool-1', ClientId: 'public-client', AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: 'refresh-1' },
    });
  });

  test('a rotated refresh token is passed back', async () => {
    mockCognito.adminInitiateAuth.mockReturnValue(ok({
      AuthenticationResult: { IdToken: 'id', AccessToken: 'a', ExpiresIn: 3600, RefreshToken: 'refresh-2' },
    }));

    expect(bodyOf(await auth.refreshSession(post({ refreshToken: 'refresh-1' }))).refreshToken).toBe('refresh-2');
  });

  test.each([['NotAuthorizedException'], ['UserNotFoundException']])('%s (revoked or expired) is a 401', async (code) => {
    mockCognito.adminInitiateAuth.mockReturnValue(fail(code));

    const res = await auth.refreshSession(post({ refreshToken: 'revoked' }));

    expect(res.statusCode).toBe(401);
  });

  test.each([[{}], [{ refreshToken: 42 }], [{ refreshToken: '' }]])('rejects %o without calling Cognito', async (body) => {
    expect((await auth.refreshSession(post(body))).statusCode).toBe(400);
    expect(mockCognito.adminInitiateAuth).not.toHaveBeenCalled();
  });
});

describe('/auth/me and logout', () => {
  test('returns the caller\'s own record', async () => {
    mockDb.get.mockReturnValue(ok({ Item: { userId: 'u1', name: 'Jo' } }));

    const res = await auth.getMe(signedIn('u1'));

    expect(bodyOf(res)).toEqual({ userId: 'u1', name: 'Jo' });
    expect(mockDb.get.mock.calls[0][0].Key).toEqual({ userId: 'u1' });
  });

  test('a token with no user record is a 404', async () => {
    mockDb.get.mockReturnValue(ok({}));

    expect((await auth.getMe(signedIn('u1'))).statusCode).toBe(404);
  });

  test('unauthenticated calls are refused', async () => {
    expect((await auth.getMe({ requestContext: {} })).statusCode).toBe(401);
    expect((await auth.logout({ requestContext: {} })).statusCode).toBe(401);
    expect((await auth.logout(signedIn('u1'))).statusCode).toBe(200);
  });
});

describe('tradie registration', () => {
  const tradie = { email: 'tom@example.com', password: 'Passw0rd!', role: 'tradie', name: 'Tom', hourlyRate: '95.5' };

  test('stores a starter tradie record with a validated rate', async () => {
    const res = await auth.register(post(tradie));

    expect(res.statusCode).toBe(201);
    expect(mockDb.put.mock.calls[0][0].Item).toMatchObject({
      role: 'tradie', hourlyRate: 95.5, rating: 0, reviewCount: 0, emailVerified: false,
    });
  });

  test.each([[undefined], ['0'], ['free'], [100000]])('rejects hourly rate %p', async (hourlyRate) => {
    const res = await auth.register(post({ ...tradie, hourlyRate }));

    expect(res.statusCode).toBe(400);
    expect(mockCognito.signUp).not.toHaveBeenCalled();
  });

  test('Cognito rate limiting is passed on as a 429', async () => {
    mockCognito.signUp.mockReturnValue(fail('TooManyRequestsException'));

    expect((await auth.register(post(tradie))).statusCode).toBe(429);
  });

  test.each([['not-an-email'], ['a@b'], ['x'.repeat(250) + '@example.com']])('rejects email %p', async (email) => {
    expect((await auth.register(post({ ...tradie, email }))).statusCode).toBe(400);
  });
});

describe('bookings list', () => {
  test('a role is required', async () => {
    expect((await bookings.getUserBookings(signedIn('u1', { queryStringParameters: {} }))).statusCode).toBe(400);
  });

  test.each([['homeowner', 'HomeownerIdIndex', 'homeownerId = :userId'], ['tradie', 'TradieIdIndex', 'tradieId = :userId']])(
    'as %s, lists only the caller\'s own bookings',
    async (role, index, condition) => {
      mockDb.query.mockReturnValue(ok({ Items: [{ bookingId: 'b1' }] }));

      const res = await bookings.getUserBookings(signedIn('u1', { queryStringParameters: { role, user_id: 'someone-else' } }));

      expect(bodyOf(res)).toMatchObject({ userId: 'u1', count: 1 });
      expect(mockDb.query.mock.calls[0][0]).toMatchObject({
        IndexName: index, KeyConditionExpression: condition, ExpressionAttributeValues: { ':userId': 'u1' },
      });
    }
  );
});

describe('pricing endpoints', () => {
  test('the calculator shows the card processing fee as its own line', async () => {
    const res = await pricing.calculatePrice(post({ hourlyRate: 90, hours: 2.5 }));

    expect(bodyOf(res)).toMatchObject({
      subtotal: 225, homeownerFee: 11.25, processingFee: 4.27, homeownerPays: 240.52, tradieEarns: 202.5,
    });
  });

  test.each([[{ hourlyRate: -1, hours: 2 }], [{ hourlyRate: 90, hours: 0 }], [{ hours: 2 }]])('rejects %o', async (body) => {
    expect((await pricing.calculatePrice(post(body))).statusCode).toBe(400);
  });

  test('a booking\'s breakdown uses the tradie\'s current rate and Pro status', async () => {
    mockDb.get.mockImplementation(({ TableName }) => ok({
      Item: TableName === 'bookings'
        ? { bookingId: 'b1', homeownerId: 'h1', tradieId: 't1', startTime: '09:00', endTime: '11:00' }
        : { userId: 't1', hourlyRate: 100, hasHomeinkPro: true },
    }));

    const res = await pricing.getPricingBreakdown(signedIn('h1', { pathParameters: { bookingId: 'b1' } }));

    expect(bodyOf(res)).toMatchObject({ duration: { hours: 2, minutes: 120 }, tradieCommission: 0, tradieEarns: 200 });
  });
});
