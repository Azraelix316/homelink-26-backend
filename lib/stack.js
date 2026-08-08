const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const iam = require('aws-cdk-lib/aws-iam');
const path = require('path');

const { createTables } = require('./tables');
const { createCognitoAuth } = require('./cognito');

class HomeLinkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Create DynamoDB tables
    const tables = createTables(this);

    // Create Cognito auth
    const cognito = createCognitoAuth(this, 'HomeLink');

    // Create Cognito authorizer for API Gateway
    const cognitoAuth = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [cognito.userPool],
    });

    // Create IAM role for Lambda functions
    const lambdaRole = new iam.Role(this, 'HomeLinkLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant DynamoDB permissions to Lambda
    tables.usersTable.grantReadWriteData(lambdaRole);
    tables.bookingsTable.grantReadWriteData(lambdaRole);
    tables.reviewsTable.grantReadWriteData(lambdaRole);
    tables.messagesTable.grantReadWriteData(lambdaRole);
    tables.scheduleTable.grantReadWriteData(lambdaRole);
    tables.profilesTable.grantReadWriteData(lambdaRole);
    tables.notificationsTable.grantReadWriteData(lambdaRole);

    // Grant Cognito permissions to Lambda
    lambdaRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminInitiateAuth',
        'cognito-idp:ListUsers',
      ],
      resources: [cognito.userPool.userPoolArn],
    }));

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'HomeLinkApi', {
      restApiName: 'HomeLink API',
      description: 'HomeLink tradies marketplace backend API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['*'],
      },
    });

    // Create Lambda functions and wire to API routes
    this.createAuthEndpoints(api, tables, cognito, lambdaRole);
    this.createProfileEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createAvailabilityEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createBookingEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createReviewEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createMessageEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createPricingEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createScheduleEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createSearchEndpoints(api, tables, cognitoAuth, lambdaRole);
    this.createNotificationEndpoints(api, tables, cognitoAuth, lambdaRole);

    // Output API endpoint
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'HomeLink API Gateway endpoint',
    });

    // Output Cognito details
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: cognito.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: cognito.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
  }

  createLambdaFunction(name, handler, tables, cognito) {
    const fn = new lambda.Function(this, name, {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: handler,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lib', 'lambdas')),
      environment: {
        USERS_TABLE: tables.usersTable.tableName,
        BOOKINGS_TABLE: tables.bookingsTable.tableName,
        REVIEWS_TABLE: tables.reviewsTable.tableName,
        MESSAGES_TABLE: tables.messagesTable.tableName,
        SCHEDULE_TABLE: tables.scheduleTable.tableName,
        PROFILES_TABLE: tables.profilesTable.tableName,
        NOTIFICATIONS_TABLE: tables.notificationsTable.tableName,
        USER_POOL_ID: cognito.userPool.userPoolId,
        CLIENT_ID: cognito.userPoolClient.userPoolClientId,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    return fn;
  }

  createAuthEndpoints(api, tables, cognito, lambdaRole) {
    const authResource = api.root.addResource('auth');
    const registerResource = authResource.addResource('register');
    const loginResource = authResource.addResource('login');
    const meResource = authResource.addResource('me');
    const logoutResource = authResource.addResource('logout');

    // POST /auth/register
    const registerFn = this.createLambdaFunction(
      'AuthRegisterFunction',
      'auth.register',
      tables,
      cognito
    );
    registerFn.role?.attachInlinePolicy(new iam.Policy(this, 'RegisterPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
          resources: [cognito.userPool.userPoolArn],
        }),
      ],
    }));
    registerResource.addMethod('POST', new apigateway.LambdaIntegration(registerFn));

    // POST /auth/login
    const loginFn = this.createLambdaFunction(
      'AuthLoginFunction',
      'auth.login',
      tables,
      cognito
    );
    loginFn.role?.attachInlinePolicy(new iam.Policy(this, 'LoginPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminInitiateAuth'],
          resources: [cognito.userPool.userPoolArn],
        }),
      ],
    }));
    loginResource.addMethod('POST', new apigateway.LambdaIntegration(loginFn));

    // GET /auth/me
    const meFn = this.createLambdaFunction('AuthMeFunction', 'auth.getMe', tables, cognito);
    meResource.addMethod('GET', new apigateway.LambdaIntegration(meFn), {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'AuthMeAuthorizer', {
        cognitoUserPools: [cognito.userPool],
      }),
    });

    // POST /auth/logout
    const logoutFn = this.createLambdaFunction('AuthLogoutFunction', 'auth.logout', tables, cognito);
    logoutResource.addMethod('POST', new apigateway.LambdaIntegration(logoutFn), {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'AuthLogoutAuthorizer', {
        cognitoUserPools: [cognito.userPool],
      }),
    });
  }

  createProfileEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const profilesResource = api.root.addResource('profiles');
    const tradieParentResource = profilesResource.addResource('tradie');

    // GET /profiles/tradie/{tradieId}
    const getTradieProfileFn = this.createLambdaFunction(
      'GetTradieProfileFunction',
      'profiles.getTradieProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    tradieParentResource.addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getTradieProfileFn));

    // GET /profiles/homeowner/{homeownerId}
    const getHomeownerProfileFn = this.createLambdaFunction(
      'GetHomeownerProfileFunction',
      'profiles.getHomeownerProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    const homeownerResource = profilesResource.addResource('homeowner').addResource('{homeownerId}');
    homeownerResource.addMethod('GET', new apigateway.LambdaIntegration(getHomeownerProfileFn));

    // PATCH /profiles/me
    const updateProfileFn = this.createLambdaFunction(
      'UpdateProfileFunction',
      'profiles.updateProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    profilesResource.addResource('me').addMethod('PATCH', new apigateway.LambdaIntegration(updateProfileFn), {
      authorizer: cognitoAuth,
    });

    // POST /profiles/tradie
    const registerTradieFn = this.createLambdaFunction(
      'RegisterTradieFunction',
      'profiles.registerTradie',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    tradieParentResource.addMethod('POST', new apigateway.LambdaIntegration(registerTradieFn), {
      authorizer: cognitoAuth,
    });
  }

  createAvailabilityEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const availResource = api.root.addResource('availability');

    // GET /availability/tradie/{tradieId}
    const getAvailFn = this.createLambdaFunction(
      'GetAvailabilityFunction',
      'availability.getAvailability',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    availResource.addResource('tradie').addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getAvailFn));

    // POST /availability/check
    const checkAvailFn = this.createLambdaFunction(
      'CheckAvailabilityFunction',
      'availability.checkAvailability',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    availResource.addResource('check').addMethod('POST', new apigateway.LambdaIntegration(checkAvailFn));
  }

  createBookingEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const bookingResource = api.root.addResource('bookings');
    const bookingIdResource = bookingResource.addResource('{bookingId}');

    // POST /bookings
    const createBookingFn = this.createLambdaFunction(
      'CreateBookingFunction',
      'bookings.createBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingResource.addMethod('POST', new apigateway.LambdaIntegration(createBookingFn), {
      authorizer: cognitoAuth,
    });

    // GET /bookings
    const getUserBookingsFn = this.createLambdaFunction(
      'GetUserBookingsFunction',
      'bookings.getUserBookings',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingResource.addMethod('GET', new apigateway.LambdaIntegration(getUserBookingsFn), {
      authorizer: cognitoAuth,
    });

    // GET /bookings/{bookingId}
    const getBookingFn = this.createLambdaFunction(
      'GetBookingFunction',
      'bookings.getBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingIdResource.addMethod('GET', new apigateway.LambdaIntegration(getBookingFn));

    // PATCH /bookings/{bookingId}
    const updateBookingFn = this.createLambdaFunction(
      'UpdateBookingFunction',
      'bookings.updateBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingIdResource.addMethod('PATCH', new apigateway.LambdaIntegration(updateBookingFn), {
      authorizer: cognitoAuth,
    });
  }

  createReviewEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const reviewResource = api.root.addResource('reviews');

    // POST /reviews
    const createReviewFn = this.createLambdaFunction(
      'CreateReviewFunction',
      'reviews.createReview',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    reviewResource.addMethod('POST', new apigateway.LambdaIntegration(createReviewFn), {
      authorizer: cognitoAuth,
    });

    // GET /reviews/tradie/{tradieId}
    const getTradieReviewsFn = this.createLambdaFunction(
      'GetTradieReviewsFunction',
      'reviews.getTradieReviews',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    reviewResource.addResource('tradie').addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getTradieReviewsFn));

    // GET /reviews
    const getBookingReviewFn = this.createLambdaFunction(
      'GetBookingReviewFunction',
      'reviews.getBookingReview',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    reviewResource.addMethod('GET', new apigateway.LambdaIntegration(getBookingReviewFn));
  }

  createMessageEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const msgResource = api.root.addResource('messages');
    const bookingMsgResource = msgResource.addResource('booking');
    const bookingIdMsgResource = bookingMsgResource.addResource('{bookingId}');

    // GET /messages/booking/{bookingId}
    const getMessagesFn = this.createLambdaFunction(
      'GetMessagesFunction',
      'messages.getMessages',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingIdMsgResource.addMethod('GET', new apigateway.LambdaIntegration(getMessagesFn), {
      authorizer: cognitoAuth,
    });

    // POST /messages/booking/{bookingId}
    const sendMessageFn = this.createLambdaFunction(
      'SendMessageFunction',
      'messages.sendMessage',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    bookingIdMsgResource.addMethod('POST', new apigateway.LambdaIntegration(sendMessageFn), {
      authorizer: cognitoAuth,
    });

    // GET /messages
    const getConversationsFn = this.createLambdaFunction(
      'GetConversationsFunction',
      'messages.getConversations',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    msgResource.addMethod('GET', new apigateway.LambdaIntegration(getConversationsFn), {
      authorizer: cognitoAuth,
    });
  }

  createPricingEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const pricingResource = api.root.addResource('pricing');

    // POST /pricing/calculate
    const calculateFn = this.createLambdaFunction(
      'CalculatePricingFunction',
      'pricing.calculatePrice',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    pricingResource.addResource('calculate').addMethod('POST', new apigateway.LambdaIntegration(calculateFn));

    // GET /pricing/breakdown/{bookingId}
    const breakdownFn = this.createLambdaFunction(
      'GetPricingBreakdownFunction',
      'pricing.getPricingBreakdown',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    pricingResource.addResource('breakdown').addResource('{bookingId}').addMethod('GET', new apigateway.LambdaIntegration(breakdownFn));
  }

  createScheduleEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const scheduleResource = api.root.addResource('schedule');
    const tradieScheduleResource = scheduleResource.addResource('tradie');
    const meScheduleResource = scheduleResource.addResource('me');
    const unavailableScheduleResource = meScheduleResource.addResource('unavailable');

    // GET /schedule/tradie/{tradieId}
    const getScheduleFn = this.createLambdaFunction(
      'GetScheduleFunction',
      'schedule.getSchedule',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    tradieScheduleResource.addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getScheduleFn));

    // PATCH /schedule/me
    const updateScheduleFn = this.createLambdaFunction(
      'UpdateScheduleFunction',
      'schedule.updateSchedule',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    meScheduleResource.addMethod('PATCH', new apigateway.LambdaIntegration(updateScheduleFn), {
      authorizer: cognitoAuth,
    });

    // POST /schedule/me/unavailable
    const markUnavailableFn = this.createLambdaFunction(
      'MarkUnavailableFunction',
      'schedule.markUnavailable',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    unavailableScheduleResource.addMethod('POST', new apigateway.LambdaIntegration(markUnavailableFn), {
      authorizer: cognitoAuth,
    });

    // DELETE /schedule/me/unavailable/{date}
    const removeUnavailableFn = this.createLambdaFunction(
      'RemoveUnavailableFunction',
      'schedule.removeUnavailable',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    unavailableScheduleResource.addResource('{date}').addMethod('DELETE', new apigateway.LambdaIntegration(removeUnavailableFn), {
      authorizer: cognitoAuth,
    });
  }

  createSearchEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const searchResource = api.root.addResource('search');

    // GET /search
    const searchFn = this.createLambdaFunction(
      'SearchTradiesFunction',
      'search.searchTradies',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    searchResource.addMethod('GET', new apigateway.LambdaIntegration(searchFn));

    // GET /trades
    const tradesFn = this.createLambdaFunction(
      'GetTradesFunction',
      'search.getTrades',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    api.root.addResource('trades').addMethod('GET', new apigateway.LambdaIntegration(tradesFn));

    // GET /locations
    const locationsFn = this.createLambdaFunction(
      'GetLocationsFunction',
      'search.getLocations',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    api.root.addResource('locations').addMethod('GET', new apigateway.LambdaIntegration(locationsFn));
  }

  createNotificationEndpoints(api, tables, cognitoAuth, lambdaRole) {
    const notifResource = api.root.addResource('notifications');
    const notifIdResource = notifResource.addResource('{notificationId}');
    const readAllResource = notifResource.addResource('read-all');

    // GET /notifications
    const getNotifFn = this.createLambdaFunction(
      'GetNotificationsFunction',
      'notifications.getNotifications',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    notifResource.addMethod('GET', new apigateway.LambdaIntegration(getNotifFn), {
      authorizer: cognitoAuth,
    });

    // PATCH /notifications/{notificationId}
    const markReadFn = this.createLambdaFunction(
      'MarkNotificationReadFunction',
      'notifications.markAsRead',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    notifIdResource.addMethod('PATCH', new apigateway.LambdaIntegration(markReadFn), {
      authorizer: cognitoAuth,
    });

    // DELETE /notifications/{notificationId}
    const deleteNotifFn = this.createLambdaFunction(
      'DeleteNotificationFunction',
      'notifications.deleteNotification',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    notifIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteNotifFn), {
      authorizer: cognitoAuth,
    });

    // PATCH /notifications/read-all
    const markAllReadFn = this.createLambdaFunction(
      'MarkAllNotificationsReadFunction',
      'notifications.markAllAsRead',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } }
    );
    readAllResource.addMethod('PATCH', new apigateway.LambdaIntegration(markAllReadFn), {
      authorizer: cognitoAuth,
    });
  }
}

module.exports = { HomeLinkStack };
