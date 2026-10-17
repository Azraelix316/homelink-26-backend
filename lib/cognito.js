const cdk = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');
const lambda = require('aws-cdk-lib/aws-lambda');
const path = require('path');

/**
 * Cognito's built-in sender is capped at 50 emails a day. Setting the
 * sesFromEmail context key (an SES-verified address in this region) sends
 * verification emails through SES instead, e.g.
 *   cdk deploy -c sesFromEmail=no-reply@homelink.com.au -c sesFromName=HomeLink
 * Optional: sesReplyTo, sesVerifiedDomain, sesConfigurationSet.
 */
function userPoolEmail(stack) {
  const fromEmail = stack.node.tryGetContext('sesFromEmail');
  if (!fromEmail) {
    return cognito.UserPoolEmail.withCognito();
  }
  return cognito.UserPoolEmail.withSES({
    fromEmail,
    fromName: stack.node.tryGetContext('sesFromName'),
    replyTo: stack.node.tryGetContext('sesReplyTo'),
    sesVerifiedDomain: stack.node.tryGetContext('sesVerifiedDomain'),
    configurationSet: stack.node.tryGetContext('sesConfigurationSet'),
  });
}

/**
 * Create Cognito User Pool and Identity Pool for HomeLink
 */
function createCognitoAuth(stack, stackName) {
  // Rejects sign-ups that did not come from POST /auth/register
  const preSignUpFn = new lambda.Function(stack, 'HomeLink' + stackName + 'PreSignUpFunction', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'pre-sign-up.handler',
    code: lambda.Code.fromAsset(path.join(__dirname, 'lambdas', 'auth')),
    timeout: cdk.Duration.seconds(5),
    memorySize: 128,
  });

  // Create User Pool
  const userPool = new cognito.UserPool(stack, 'HomeLink' + stackName + 'UserPool', {
    userPoolName: 'homelink-users-' + stackName.toLowerCase(),
    // Needed so the backend can call SignUp, which leaves the user UNCONFIRMED
    // (unable to log in) and emails a verification code. The pre sign-up
    // trigger blocks direct sign-ups that bypass the API.
    selfSignUpEnabled: true,
    autoVerify: { email: true },
    userVerification: {
      emailStyle: cognito.VerificationEmailStyle.CODE,
      emailSubject: 'Your HomeLink verification code',
      emailBody: 'Welcome to HomeLink! Your verification code is {####}. It expires in 24 hours.',
    },
    email: userPoolEmail(stack),
    lambdaTriggers: { preSignUp: preSignUpFn },
    passwordPolicy: {
      minLength: 8,
      requireDigits: true,
      requireLowercase: true,
      requireSymbols: false,
      requireUppercase: false,
    },
    customAttributes: {
      role: new cognito.StringAttribute({ mutable: true }),
      userId: new cognito.StringAttribute({ mutable: false }),
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // Create User Pool Client (for app authentication)
  const userPoolClient = userPool.addClient('HomeLink' + stackName + 'Client', {
    clientName: 'homelink-app-client',
    authFlows: {
      adminUserPasswordBased: true,
      userPassword: true,
    },
    // Users may only change their own name. custom:role and custom:userId
    // are trusted by the API, so they must never be user-writable.
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
  });

  // Backend-only client used by POST /auth/register, /auth/confirm and
  // /auth/resend-code. Its secret never leaves AWS (the Lambdas read it with
  // DescribeUserPoolClient), so only the backend can set custom:role and
  // custom:userId at sign-up.
  const registrationClient = userPool.addClient('HomeLink' + stackName + 'RegistrationClient', {
    userPoolClientName: 'homelink-registration-client',
    generateSecret: true,
    disableOAuth: true,
    authFlows: { adminUserPassword: false },
    writeAttributes: new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, fullname: true })
      .withCustomAttributes('role', 'userId'),
  });

  // Create Identity Pool (for AWS resource access)
  const identityPool = new cognito.CfnIdentityPool(stack, 'HomeLink' + stackName + 'IdentityPool', {
    identityPoolName: 'homelink-identity-' + stackName.toLowerCase(),
    allowUnauthenticatedIdentities: false,
    cognitoIdentityProviders: [
      {
        clientId: userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
      },
    ],
  });

  // Create IAM role for authenticated users
  const authenticatedRole = new cdk.aws_iam.Role(stack, 'HomeLink' + stackName + 'AuthenticatedRole', {
    assumedBy: new cdk.aws_iam.FederatedPrincipal(
      'cognito-identity.amazonaws.com',
      {
        StringEquals: {
          'cognito-identity.amazonaws.com:aud': identityPool.ref,
        },
        'ForAllValues:StringLike': {
          'cognito-identity.amazonaws.com:sub_id': '*',
        },
      },
      'sts:AssumeRoleWithWebIdentity'
    ),
  });

  // Attach role to identity pool
  new cognito.CfnIdentityPoolRoleAttachment(stack, 'HomeLink' + stackName + 'RoleAttachment', {
    identityPoolId: identityPool.ref,
    roles: {
      authenticated: authenticatedRole.roleArn,
    },
  });

  return {
    userPool,
    userPoolClient,
    registrationClient,
    identityPool,
    authenticatedRole,
  };
}

module.exports = { createCognitoAuth };
