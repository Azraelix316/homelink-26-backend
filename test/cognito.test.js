// User pool configuration for email verification, checked against the synthesized template

const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { HomeLinkStack } = require('../lib/stack');

function synth(context = {}) {
  const app = new cdk.App({ context });
  return Template.fromStack(new HomeLinkStack(app, 'TestStack', { env: { region: 'ap-southeast-2' } }));
}

describe('user pool', () => {
  const template = synth();

  test('verifies email addresses with a code and gates sign-up with a trigger', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      VerificationMessageTemplate: Match.objectLike({ DefaultEmailOption: 'CONFIRM_WITH_CODE' }),
      LambdaConfig: { PreSignUp: Match.anyValue() },
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
    });
  });

  test('only the secret registration client can write role and userId', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: Match.absent(),
      WriteAttributes: ['name'],
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'homelink-registration-client',
      GenerateSecret: true,
      WriteAttributes: Match.arrayEquals(['custom:role', 'custom:userId', 'email', 'name']),
    });
  });

  test('exposes the confirm and resend-code endpoints', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'confirm' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'resend-code' });
  });

  test('sends through SES when sesFromEmail is set', () => {
    synth({ sesFromEmail: 'no-reply@homelink.example', sesFromName: 'HomeLink' })
      .hasResourceProperties('AWS::Cognito::UserPool', {
        EmailConfiguration: Match.objectLike({
          EmailSendingAccount: 'DEVELOPER',
          From: 'HomeLink <no-reply@homelink.example>',
        }),
      });
  });
});
