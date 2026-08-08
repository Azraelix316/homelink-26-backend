#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { HomeLinkStack } = require('../lib/stack');

const app = new cdk.App();
new HomeLinkStack(app, 'HomeLinkBackendStack', {
  description: 'HomeLink Backend - AWS CDK Infrastructure with DynamoDB, Lambda, API Gateway, and Cognito',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  tags: {
    Project: 'HomeLink',
    Environment: 'Development',
  },
});
