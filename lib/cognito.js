const cdk = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');

/**
 * Create Cognito User Pool and Identity Pool for HomeLink
 */
function createCognitoAuth(stack, stackName) {
  // Create User Pool
  const userPool = new cognito.UserPool(stack, 'HomeLink' + stackName + 'UserPool', {
    userPoolName: 'homelink-users-' + stackName.toLowerCase(),
    selfSignUpEnabled: false,
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
    identityPool,
    authenticatedRole,
  };
}

module.exports = { createCognitoAuth };
