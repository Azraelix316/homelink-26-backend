// Registration, email verification and login tests, with Cognito and DynamoDB mocked

const crypto = require('crypto');

const ok = value => ({ promise: () => Promise.resolve(value) });
const fail = code => ({ promise: () => Promise.reject(Object.assign(new Error(code), { code })) });

const mockDb = { get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn() };
const mockCognito = {
  describeUserPoolClient: jest.fn(),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  resendConfirmationCode: jest.fn(),
  adminGetUser: jest.fn(),
  adminDeleteUser: jest.fn(),
  adminInitiateAuth: jest.fn(),
  adminCreateUser: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockDb) },
  CognitoIdentityServiceProvider: jest.fn(() => mockCognito),
}));

Object.assign(process.env, {
  USERS_TABLE: 'users',
  USER_POOL_ID: 'pool-1',
  CLIENT_ID: 'public-client',
  REGISTRATION_CLIENT_ID: 'registration-client',
});

const auth = require('../lib/lambdas/auth');
const preSignUp = require('../lib/lambdas/auth/pre-sign-up');

const SECRET = 'registration-secret';
const post = body => ({ body: JSON.stringify(body) });
const homeowner = { email: 'jo@example.com', password: 'Passw0rd!', role: 'homeowner', name: 'Jo' };
const attrs = values => Object.entries(values).map(([Name, Value]) => ({ Name, Value }));
const expectedHash = username =>
  crypto.createHmac('sha256', SECRET).update(username + 'registration-client').digest('base64');

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.put.mockReturnValue(ok({}));
  mockDb.update.mockReturnValue(ok({}));
  mockDb.delete.mockReturnValue(ok({}));
  mockCognito.describeUserPoolClient.mockReturnValue(ok({ UserPoolClient: { ClientSecret: SECRET } }));
  mockCognito.signUp.mockReturnValue(ok({ UserConfirmed: false, CodeDeliveryDetails: { Destination: 'j***@e***' } }));
  mockCognito.confirmSignUp.mockReturnValue(ok({}));
  mockCognito.resendConfirmationCode.mockReturnValue(ok({}));
  mockCognito.adminDeleteUser.mockReturnValue(ok({}));
});

describe('register', () => {
  test('signs up through Cognito so a verification code is emailed', async () => {
    const res = await auth.register(post(homeowner));
    const params = mockCognito.signUp.mock.calls[0][0];

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ emailVerified: false, codeDeliveryDestination: 'j***@e***' });
    expect(params.ClientId).toBe('registration-client');
    expect(params.SecretHash).toBe(expectedHash('jo@example.com'));
    expect(mockCognito.adminCreateUser).not.toHaveBeenCalled();
  });

  test('never marks the email as verified', async () => {
    await auth.register(post(homeowner));

    const names = mockCognito.signUp.mock.calls[0][0].UserAttributes.map(a => a.Name);
    expect(names).not.toContain('email_verified');
    expect(mockDb.put.mock.calls[0][0].Item.emailVerified).toBe(false);
  });

  test('sets role and userId server-side, ignoring client-supplied values', async () => {
    const res = await auth.register(post({ ...homeowner, userId: 'chosen-id', 'custom:role': 'admin' }));
    const sent = Object.fromEntries(mockCognito.signUp.mock.calls[0][0].UserAttributes.map(a => [a.Name, a.Value]));

    expect(sent['custom:role']).toBe('homeowner');
    expect(sent['custom:userId']).toBe(JSON.parse(res.body).userId);
    expect(sent['custom:userId']).not.toBe('chosen-id');
    expect(mockDb.put.mock.calls[0][0].Item.userId).toBe(sent['custom:userId']);
  });

  test('rejects roles other than tradie and homeowner', async () => {
    const res = await auth.register(post({ ...homeowner, role: 'admin' }));

    expect(res.statusCode).toBe(400);
    expect(mockCognito.signUp).not.toHaveBeenCalled();
  });

  test('an unconfirmed registration does not block the real owner of the address', async () => {
    mockCognito.signUp
      .mockReturnValueOnce(fail('UsernameExistsException'))
      .mockReturnValueOnce(ok({ UserConfirmed: false }));
    mockCognito.adminGetUser.mockReturnValue(ok({
      UserStatus: 'UNCONFIRMED',
      UserAttributes: attrs({ 'custom:userId': 'squatter-id' }),
    }));

    const res = await auth.register(post(homeowner));

    expect(res.statusCode).toBe(201);
    expect(mockCognito.adminDeleteUser).toHaveBeenCalledWith({ UserPoolId: 'pool-1', Username: 'jo@example.com' });
    expect(mockDb.delete).toHaveBeenCalledWith({ TableName: 'users', Key: { userId: 'squatter-id' } });
    expect(mockCognito.signUp).toHaveBeenCalledTimes(2);
  });

  test('a confirmed account is never replaced', async () => {
    mockCognito.signUp.mockReturnValue(fail('UsernameExistsException'));
    mockCognito.adminGetUser.mockReturnValue(ok({ UserStatus: 'CONFIRMED', UserAttributes: [] }));

    const res = await auth.register(post(homeowner));

    expect(res.statusCode).toBe(409);
    expect(mockCognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mockDb.put).not.toHaveBeenCalled();
  });

  test('weak passwords get a 400', async () => {
    mockCognito.signUp.mockReturnValue(fail('InvalidPasswordException'));

    const res = await auth.register(post(homeowner));

    expect(res.statusCode).toBe(400);
  });
});

describe('confirm', () => {
  test('confirms the code and marks the user record verified', async () => {
    mockCognito.adminGetUser.mockReturnValue(ok({ UserAttributes: attrs({ 'custom:userId': 'user-1' }) }));

    const res = await auth.confirmRegistration(post({ email: 'jo@example.com', code: '123456' }));

    expect(res.statusCode).toBe(200);
    expect(mockCognito.confirmSignUp).toHaveBeenCalledWith({
      ClientId: 'registration-client',
      SecretHash: expectedHash('jo@example.com'),
      Username: 'jo@example.com',
      ConfirmationCode: '123456',
    });
    expect(mockDb.update.mock.calls[0][0]).toMatchObject({
      Key: { userId: 'user-1' },
      ExpressionAttributeValues: { ':true': true },
    });
  });

  test.each([['CodeMismatchException'], ['ExpiredCodeException']])('%s is a 400', async (code) => {
    mockCognito.confirmSignUp.mockReturnValue(fail(code));

    const res = await auth.confirmRegistration(post({ email: 'jo@example.com', code: '000000' }));

    expect(res.statusCode).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  test('rejects malformed codes without calling Cognito', async () => {
    const res = await auth.confirmRegistration(post({ email: 'jo@example.com', code: 'abc' }));

    expect(res.statusCode).toBe(400);
    expect(mockCognito.confirmSignUp).not.toHaveBeenCalled();
  });
});

describe('resend code', () => {
  test('resends for unconfirmed users', async () => {
    const res = await auth.resendConfirmationCode(post({ email: 'jo@example.com' }));

    expect(res.statusCode).toBe(200);
    expect(mockCognito.resendConfirmationCode.mock.calls[0][0].SecretHash).toBe(expectedHash('jo@example.com'));
  });

  test('does not reveal whether an address is registered', async () => {
    mockCognito.resendConfirmationCode.mockReturnValueOnce(fail('UserNotFoundException'));
    const unknown = await auth.resendConfirmationCode(post({ email: 'nobody@example.com' }));
    const known = await auth.resendConfirmationCode(post({ email: 'jo@example.com' }));

    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
  });
});

describe('login', () => {
  test('unverified users cannot log in', async () => {
    mockCognito.adminInitiateAuth.mockReturnValue(fail('UserNotConfirmedException'));

    const res = await auth.login(post({ email: 'jo@example.com', password: 'Passw0rd!' }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('pre sign-up trigger', () => {
  const event = userAttributes => ({ request: { userAttributes }, response: {} });

  test('rejects direct sign-ups that bypass the API', async () => {
    await expect(preSignUp.handler(event({ email: 'jo@example.com', name: 'Jo' }))).rejects.toThrow();
  });

  test('accepts API sign-ups and never auto-confirms them', async () => {
    const result = await preSignUp.handler(event({ 'custom:userId': 'u1', 'custom:role': 'tradie' }));

    expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false });
  });
});
