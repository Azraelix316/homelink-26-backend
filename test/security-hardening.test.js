// Security hardening: IAM scope, per-route throttles, logout revocation and response headers

const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { HomeLinkStack } = require('../lib/stack');

const template = Template.fromStack(new HomeLinkStack(new cdk.App(), 'TestStack', { env: { region: 'ap-southeast-2' } }));
const resources = template.toJSON().Resources;
const statements = Object.values(resources)
  .filter(r => r.Type === 'AWS::IAM::Policy')
  .flatMap(r => r.Properties.PolicyDocument.Statement);
const asList = value => (Array.isArray(value) ? value : [value]);

describe('IAM', () => {
  test('no inline policy grants an action on every resource', () => {
    const wildcards = statements.filter(s => asList(s.Resource).includes('*'));
    expect(wildcards).toEqual([]);
  });

  test('Cognito admin actions are scoped to the user pool', () => {
    const cognito = statements.filter(s => asList(s.Action).some(a => a.startsWith('cognito-idp:')));
    expect(cognito.length).toBeGreaterThan(0);
    for (const statement of cognito) {
      expect(JSON.stringify(statement.Resource)).toContain('UserPool');
    }
  });

  test('only the payment Lambdas can read the Stripe secret', () => {
    const readers = Object.entries(resources)
      .filter(([, r]) => r.Type === 'AWS::IAM::Policy'
        && r.Properties.PolicyDocument.Statement.some(s => asList(s.Action).includes('secretsmanager:GetSecretValue')))
      .map(([id]) => id);
    expect(readers.length).toBeGreaterThan(0);
    for (const id of readers) {
      expect(id).toMatch(/Payment|Connect|ProSubscribe|ProPortal|Webhook/);
    }
  });

  test('no Lambda environment carries a Stripe key', () => {
    const env = JSON.stringify(Object.values(resources)
      .filter(r => r.Type === 'AWS::Lambda::Function')
      .map(r => r.Properties.Environment));
    expect(env).not.toMatch(/sk_(test|live)_|whsec_/);
  });

  test('logout may revoke sessions', () => {
    const logout = statements.filter(s => asList(s.Action).includes('cognito-idp:AdminUserGlobalSignOut'));
    expect(logout).toHaveLength(1);
  });
});

describe('API Gateway', () => {
  const stage = Object.values(resources).find(r => r.Type === 'AWS::ApiGateway::Stage');
  const settings = Object.fromEntries(stage.Properties.MethodSettings.map(s => [`${s.HttpMethod} ${s.ResourcePath}`, s]));

  test.each([
    ['POST /~1auth~1register', 5],
    ['POST /~1auth~1resend-code', 2],
    ['POST /~1auth~1confirm', 5],
    ['POST /~1auth~1login', 10],
    ['GET /~1search', 20],
  ])('%s is throttled to %i requests a second', (key, rate) => {
    expect(settings[key]).toMatchObject({ ThrottlingRateLimit: rate });
  });

  test('everything else keeps the stage-wide limit', () => {
    expect(settings['* /*']).toMatchObject({ ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 });
  });

  test('only sign-in, sign-up, browsing and the Stripe webhook are public', () => {
    const publicMethods = Object.entries(resources)
      .filter(([, r]) => r.Type === 'AWS::ApiGateway::Method'
        && r.Properties.HttpMethod !== 'OPTIONS' && r.Properties.AuthorizationType === 'NONE')
      .map(([id]) => id);
    for (const id of publicMethods) {
      expect(id).toMatch(/auth(login|register|confirm|resendcode)|availability|locations|pricing(calculate|estimate)|profiles(homeowner|tradie)|reviews|schedule|search|trades|paymentswebhook/);
    }
  });
});

describe('handlers', () => {
  const ok = value => ({ promise: () => Promise.resolve(value) });

  test('responses are never sniffed or cached', () => {
    const { response } = require('../lib/utils');
    expect(response(200, {}).headers).toMatchObject({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  });

  test('logout revokes the user\'s Cognito sessions', async () => {
    await jest.isolateModulesAsync(async () => {
      const signOut = jest.fn(() => ok({}));
      jest.doMock('aws-sdk', () => ({
        DynamoDB: { DocumentClient: jest.fn(() => ({})) },
        CognitoIdentityServiceProvider: jest.fn(() => ({ adminUserGlobalSignOut: signOut })),
      }));
      process.env.USER_POOL_ID = 'pool-1';
      const auth = require('../lib/lambdas/auth');

      const res = await auth.logout({
        requestContext: { authorizer: { claims: { 'custom:userId': 'u1', 'cognito:username': 'jo@example.com' } } },
      });

      expect(res.statusCode).toBe(200);
      expect(signOut).toHaveBeenCalledWith({ UserPoolId: 'pool-1', Username: 'jo@example.com' });
      jest.dontMock('aws-sdk');
    });
  });
});
