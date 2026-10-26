const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const iam = require('aws-cdk-lib/aws-iam');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
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
    this.createAuthEndpoints(api, tables, cognito);
    this.createProfileEndpoints(api, tables, cognitoAuth);
    this.createAvailabilityEndpoints(api, tables, cognitoAuth);
    this.createBookingEndpoints(api, tables, cognitoAuth);
    this.createReviewEndpoints(api, tables, cognitoAuth);
    this.createMessageEndpoints(api, tables, cognitoAuth);
    this.createPricingEndpoints(api, tables, cognitoAuth);
    this.createScheduleEndpoints(api, tables, cognitoAuth);
    this.createSearchEndpoints(api, tables, cognitoAuth);
    this.createNotificationEndpoints(api, tables, cognitoAuth);
    this.createPaymentEndpoints(api, tables, cognitoAuth);

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

  createLambdaFunction(name, handler, tables, cognito, requiredTables, requiresCognito) {
    // Extract the module name from handler (e.g., 'auth.register' -> 'auth')
    const moduleName = handler.split('.')[0];
    
    const fn = new lambda.Function(this, name, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: `index.${handler.split('.')[1]}`,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambdas', moduleName)),
      environment: {
        USERS_TABLE: tables.usersTable.tableName,
        BOOKINGS_TABLE: tables.bookingsTable.tableName,
        REVIEWS_TABLE: tables.reviewsTable.tableName,
        MESSAGES_TABLE: tables.messagesTable.tableName,
        SCHEDULE_TABLE: tables.scheduleTable.tableName,
        PROFILES_TABLE: tables.profilesTable.tableName,
        NOTIFICATIONS_TABLE: tables.notificationsTable.tableName,
        PAYMENTS_TABLE: tables.paymentsTable.tableName,
        USER_POOL_ID: cognito.userPool.userPoolId,
        CLIENT_ID: cognito.userPoolClient.userPoolClientId,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // Grant permissions to specific tables based on what this Lambda needs
    if (requiredTables) {
      requiredTables.forEach(tableAccess => {
        const { table, operations } = tableAccess;
        if (operations.includes('read') && operations.includes('write')) {
          table.grantReadWriteData(fn);
        } else if (operations.includes('read')) {
          table.grantReadData(fn);
        } else if (operations.includes('write')) {
          table.grantWriteData(fn);
        }
      });
    }

    // Grant Cognito permissions if needed
    if (requiresCognito) {
      fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [cognito.userPool.userPoolArn],
      }));
    }

    return fn;
  }

  createAuthEndpoints(api, tables, cognito) {
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
      cognito,
      [{ table: tables.usersTable, operations: ['write'] }],
      true
    );
    registerResource.addMethod('POST', new apigateway.LambdaIntegration(registerFn));

    // POST /auth/login
    const loginFn = this.createLambdaFunction(
      'AuthLoginFunction',
      'auth.login',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['read'] }],
      true
    );
    loginResource.addMethod('POST', new apigateway.LambdaIntegration(loginFn));

    // GET /auth/me
    const meFn = this.createLambdaFunction(
      'AuthMeFunction',
      'auth.getMe',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['read'] }],
      false
    );
    meResource.addMethod('GET', new apigateway.LambdaIntegration(meFn), {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'AuthMeAuthorizer', {
        cognitoUserPools: [cognito.userPool],
      }),
    });

    // DELETE /auth/me — initiate the App Store-compliant account deletion flow
    const deleteAccountFn = this.createLambdaFunction(
      'AuthDeleteAccountFunction',
      'auth.requestAccountDeletion',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['write'] }],
      false
    );
    meResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteAccountFn), {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'AuthDeleteAccountAuthorizer', {
        cognitoUserPools: [cognito.userPool],
      }),
    });

    // POST /auth/logout
    const logoutFn = this.createLambdaFunction(
      'AuthLogoutFunction',
      'auth.logout',
      tables,
      cognito,
      [],
      false
    );
    logoutResource.addMethod('POST', new apigateway.LambdaIntegration(logoutFn), {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'AuthLogoutAuthorizer', {
        cognitoUserPools: [cognito.userPool],
      }),
    });
  }

  createProfileEndpoints(api, tables, cognitoAuth) {
    const profilesResource = api.root.addResource('profiles');
    const tradieParentResource = profilesResource.addResource('tradie');

    // GET /profiles/tradie/{tradieId}
    const getTradieProfileFn = this.createLambdaFunction(
      'GetTradieProfileFunction',
      'profiles.getTradieProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] },
        { table: tables.profilesTable, operations: ['read'] },
        { table: tables.reviewsTable, operations: ['read'] }
      ],
      false
    );
    tradieParentResource.addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getTradieProfileFn));

    // GET /profiles/homeowner/{homeownerId}
    const getHomeownerProfileFn = this.createLambdaFunction(
      'GetHomeownerProfileFunction',
      'profiles.getHomeownerProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    const homeownerResource = profilesResource.addResource('homeowner').addResource('{homeownerId}');
    homeownerResource.addMethod('GET', new apigateway.LambdaIntegration(getHomeownerProfileFn));

    // PATCH /profiles/me
    const updateProfileFn = this.createLambdaFunction(
      'UpdateProfileFunction',
      'profiles.updateProfile',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read', 'write'] },
        { table: tables.profilesTable, operations: ['read', 'write'] },
        { table: tables.reviewsTable, operations: ['read'] }
      ],
      false
    );
    profilesResource.addResource('me').addMethod('PATCH', new apigateway.LambdaIntegration(updateProfileFn), {
      authorizer: cognitoAuth,
    });

    // POST /profiles/tradie
    const registerTradieFn = this.createLambdaFunction(
      'RegisterTradieFunction',
      'profiles.registerTradie',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.profilesTable, operations: ['read', 'write'] },
        { table: tables.usersTable, operations: ['write'] }
      ],
      false
    );
    tradieParentResource.addMethod('POST', new apigateway.LambdaIntegration(registerTradieFn), {
      authorizer: cognitoAuth,
    });
  }

  createAvailabilityEndpoints(api, tables, cognitoAuth) {
    const availResource = api.root.addResource('availability');

    // GET /availability/tradie/{tradieId}
    const getAvailFn = this.createLambdaFunction(
      'GetAvailabilityFunction',
      'availability.getAvailability',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    availResource.addResource('tradie').addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getAvailFn));

    // POST /availability/check
    const checkAvailFn = this.createLambdaFunction(
      'CheckAvailabilityFunction',
      'availability.checkAvailability',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    availResource.addResource('check').addMethod('POST', new apigateway.LambdaIntegration(checkAvailFn));
  }

  createBookingEndpoints(api, tables, cognitoAuth) {
    const bookingResource = api.root.addResource('bookings');
    const bookingIdResource = bookingResource.addResource('{bookingId}');

    // POST /bookings
    const createBookingFn = this.createLambdaFunction(
      'CreateBookingFunction',
      'bookings.createBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.scheduleTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] },
        { table: tables.notificationsTable, operations: ['write'] }
      ],
      false
    );
    bookingResource.addMethod('POST', new apigateway.LambdaIntegration(createBookingFn), {
      authorizer: cognitoAuth,
    });

    // GET /bookings
    const getUserBookingsFn = this.createLambdaFunction(
      'GetUserBookingsFunction',
      'bookings.getUserBookings',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    bookingResource.addMethod('GET', new apigateway.LambdaIntegration(getUserBookingsFn), {
      authorizer: cognitoAuth,
    });

    // GET /bookings/{bookingId}
    const getBookingFn = this.createLambdaFunction(
      'GetBookingFunction',
      'bookings.getBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    bookingIdResource.addMethod('GET', new apigateway.LambdaIntegration(getBookingFn), {
      authorizer: cognitoAuth,
    });

    // PATCH /bookings/{bookingId}
    const updateBookingFn = this.createLambdaFunction(
      'UpdateBookingFunction',
      'bookings.updateBooking',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.notificationsTable, operations: ['write'] }
      ],
      false
    );
    bookingIdResource.addMethod('PATCH', new apigateway.LambdaIntegration(updateBookingFn), {
      authorizer: cognitoAuth,
    });
  }

  createReviewEndpoints(api, tables, cognitoAuth) {
    const reviewResource = api.root.addResource('reviews');

    // POST /reviews
    const createReviewFn = this.createLambdaFunction(
      'CreateReviewFunction',
      'reviews.createReview',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.reviewsTable, operations: ['write'] },
        { table: tables.bookingsTable, operations: ['read', 'write'] }
      ],
      false
    );
    reviewResource.addMethod('POST', new apigateway.LambdaIntegration(createReviewFn), {
      authorizer: cognitoAuth,
    });

    // GET /reviews/tradie/{tradieId}
    const getTradieReviewsFn = this.createLambdaFunction(
      'GetTradieReviewsFunction',
      'reviews.getTradieReviews',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.reviewsTable, operations: ['read'] }
      ],
      false
    );
    reviewResource.addResource('tradie').addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getTradieReviewsFn));

    // GET /reviews
    const getBookingReviewFn = this.createLambdaFunction(
      'GetBookingReviewFunction',
      'reviews.getBookingReview',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.reviewsTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    reviewResource.addMethod('GET', new apigateway.LambdaIntegration(getBookingReviewFn));
  }

  createMessageEndpoints(api, tables, cognitoAuth) {
    const msgResource = api.root.addResource('messages');
    const bookingMsgResource = msgResource.addResource('booking');
    const bookingIdMsgResource = bookingMsgResource.addResource('{bookingId}');

    // GET /messages/booking/{bookingId}
    const getMessagesFn = this.createLambdaFunction(
      'GetMessagesFunction',
      'messages.getMessages',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.messagesTable, operations: ['read', 'write'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    bookingIdMsgResource.addMethod('GET', new apigateway.LambdaIntegration(getMessagesFn), {
      authorizer: cognitoAuth,
    });

    // POST /messages/booking/{bookingId}
    const sendMessageFn = this.createLambdaFunction(
      'SendMessageFunction',
      'messages.sendMessage',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.messagesTable, operations: ['write'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    bookingIdMsgResource.addMethod('POST', new apigateway.LambdaIntegration(sendMessageFn), {
      authorizer: cognitoAuth,
    });

    // GET /messages
    const getConversationsFn = this.createLambdaFunction(
      'GetConversationsFunction',
      'messages.getConversations',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.messagesTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    msgResource.addMethod('GET', new apigateway.LambdaIntegration(getConversationsFn), {
      authorizer: cognitoAuth,
    });
  }

  createPricingEndpoints(api, tables, cognitoAuth) {
    const pricingResource = api.root.addResource('pricing');

    const estimateFn = this.createLambdaFunction(
      'EstimatePricingFunction',
      'pricing.estimatePrice',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [{ table: tables.usersTable, operations: ['read'] }],
      false
    );
    pricingResource.addResource('estimate').addMethod('POST', new apigateway.LambdaIntegration(estimateFn));

    // POST /pricing/calculate
    const calculateFn = this.createLambdaFunction(
      'CalculatePricingFunction',
      'pricing.calculatePrice',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    pricingResource.addResource('calculate').addMethod('POST', new apigateway.LambdaIntegration(calculateFn));

    // GET /pricing/breakdown/{bookingId}
    const breakdownFn = this.createLambdaFunction(
      'GetPricingBreakdownFunction',
      'pricing.getPricingBreakdown',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    pricingResource.addResource('breakdown').addResource('{bookingId}').addMethod('GET', new apigateway.LambdaIntegration(breakdownFn));
  }

  createScheduleEndpoints(api, tables, cognitoAuth) {
    const scheduleResource = api.root.addResource('schedule');
    const tradieScheduleResource = scheduleResource.addResource('tradie');
    const meScheduleResource = scheduleResource.addResource('me');
    const unavailableScheduleResource = meScheduleResource.addResource('unavailable');
    const blockScheduleResource = meScheduleResource.addResource('blocks');

    // GET /schedule/tradie/{tradieId}
    const getScheduleFn = this.createLambdaFunction(
      'GetScheduleFunction',
      'schedule.getSchedule',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read'] }
      ],
      false
    );
    tradieScheduleResource.addResource('{tradieId}').addMethod('GET', new apigateway.LambdaIntegration(getScheduleFn));

    // PATCH /schedule/me
    const updateScheduleFn = this.createLambdaFunction(
      'UpdateScheduleFunction',
      'schedule.updateSchedule',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read', 'write'] }
      ],
      false
    );
    meScheduleResource.addMethod('PATCH', new apigateway.LambdaIntegration(updateScheduleFn), {
      authorizer: cognitoAuth,
    });

    // POST /schedule/me/unavailable
    const markUnavailableFn = this.createLambdaFunction(
      'MarkUnavailableFunction',
      'schedule.markUnavailable',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read', 'write'] }
      ],
      false
    );
    unavailableScheduleResource.addMethod('POST', new apigateway.LambdaIntegration(markUnavailableFn), {
      authorizer: cognitoAuth,
    });

    // DELETE /schedule/me/unavailable/{date}
    const removeUnavailableFn = this.createLambdaFunction(
      'RemoveUnavailableFunction',
      'schedule.removeUnavailable',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read', 'write'] }
      ],
      false
    );
    unavailableScheduleResource.addResource('{date}').addMethod('DELETE', new apigateway.LambdaIntegration(removeUnavailableFn), {
      authorizer: cognitoAuth,
    });

    const createTimeBlockFn = this.createLambdaFunction(
      'CreateTimeBlockFunction',
      'schedule.createTimeBlock',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read', 'write'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    blockScheduleResource.addMethod('POST', new apigateway.LambdaIntegration(createTimeBlockFn), {
      authorizer: cognitoAuth,
    });

    const removeTimeBlockFn = this.createLambdaFunction(
      'RemoveTimeBlockFunction',
      'schedule.removeTimeBlock',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.scheduleTable, operations: ['read', 'write'] }
      ],
      false
    );
    blockScheduleResource.addResource('{blockId}').addMethod('DELETE', new apigateway.LambdaIntegration(removeTimeBlockFn), {
      authorizer: cognitoAuth,
    });
  }

  createSearchEndpoints(api, tables, cognitoAuth) {
    const searchResource = api.root.addResource('search');

    // GET /search
    const searchFn = this.createLambdaFunction(
      'SearchTradiesFunction',
      'search.searchTradies',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] },
        { table: tables.profilesTable, operations: ['read'] },
        { table: tables.reviewsTable, operations: ['read'] }
      ],
      false
    );
    searchResource.addMethod('GET', new apigateway.LambdaIntegration(searchFn));

    // GET /trades
    const tradesFn = this.createLambdaFunction(
      'GetTradesFunction',
      'search.getTrades',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    api.root.addResource('trades').addMethod('GET', new apigateway.LambdaIntegration(tradesFn));

    // GET /locations
    const locationsFn = this.createLambdaFunction(
      'GetLocationsFunction',
      'search.getLocations',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    api.root.addResource('locations').addMethod('GET', new apigateway.LambdaIntegration(locationsFn));
  }

  createNotificationEndpoints(api, tables, cognitoAuth) {
    const notifResource = api.root.addResource('notifications');
    const notifIdResource = notifResource.addResource('{notificationId}');
    const readAllResource = notifResource.addResource('read-all');

    // GET /notifications
    const getNotifFn = this.createLambdaFunction(
      'GetNotificationsFunction',
      'notifications.getNotifications',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.notificationsTable, operations: ['read'] }
      ],
      false
    );
    notifResource.addMethod('GET', new apigateway.LambdaIntegration(getNotifFn), {
      authorizer: cognitoAuth,
    });

    // PATCH /notifications/{notificationId}
    const markReadFn = this.createLambdaFunction(
      'MarkNotificationReadFunction',
      'notifications.markAsRead',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.notificationsTable, operations: ['read', 'write'] }
      ],
      false
    );
    notifIdResource.addMethod('PATCH', new apigateway.LambdaIntegration(markReadFn), {
      authorizer: cognitoAuth,
    });

    // DELETE /notifications/{notificationId}
    const deleteNotifFn = this.createLambdaFunction(
      'DeleteNotificationFunction',
      'notifications.deleteNotification',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.notificationsTable, operations: ['read', 'write'] }
      ],
      false
    );
    notifIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteNotifFn), {
      authorizer: cognitoAuth,
    });

    // PATCH /notifications/read-all
    const markAllReadFn = this.createLambdaFunction(
      'MarkAllNotificationsReadFunction',
      'notifications.markAllAsRead',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.notificationsTable, operations: ['read', 'write'] }
      ],
      false
    );
    readAllResource.addMethod('PATCH', new apigateway.LambdaIntegration(markAllReadFn), {
      authorizer: cognitoAuth,
    });
  }

  createPaymentEndpoints(api, tables, cognitoAuth) {
    const stripeSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'StripeSecret',
      this.node.tryGetContext('stripeSecretName') || 'homelink/stripe'
    );
    const paymentsResource = api.root.addResource('payments');
    const paymentIdResource = paymentsResource.addResource('{paymentId}');
    const bookingPaymentsResource = paymentsResource.addResource('booking');

    // POST /payments/create-payment-intent
    const createIntentFn = this.createLambdaFunction(
      'CreatePaymentIntentFunction',
      'payments.createPaymentIntent',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.paymentsTable, operations: ['write'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    createIntentFn.addEnvironment('STRIPE_SECRET_NAME', stripeSecret.secretName);
    stripeSecret.grantRead(createIntentFn);
    paymentsResource.addResource('create-payment-intent').addMethod('POST', new apigateway.LambdaIntegration(createIntentFn), {
      authorizer: cognitoAuth,
    });

    // POST /payments/confirm-payment
    const confirmPaymentFn = this.createLambdaFunction(
      'ConfirmPaymentFunction',
      'payments.confirmPayment',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.paymentsTable, operations: ['write'] },
        { table: tables.notificationsTable, operations: ['write'] }
      ],
      false
    );
    confirmPaymentFn.addEnvironment('STRIPE_SECRET_NAME', stripeSecret.secretName);
    stripeSecret.grantRead(confirmPaymentFn);
    paymentsResource.addResource('confirm-payment').addMethod('POST', new apigateway.LambdaIntegration(confirmPaymentFn), {
      authorizer: cognitoAuth,
    });

    // GET /payments/{paymentId}
    const getPaymentFn = this.createLambdaFunction(
      'GetPaymentFunction',
      'payments.getPayment',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.paymentsTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    paymentIdResource.addMethod('GET', new apigateway.LambdaIntegration(getPaymentFn), {
      authorizer: cognitoAuth,
    });

    // GET /payments/booking/{bookingId}
    const getBookingPaymentFn = this.createLambdaFunction(
      'GetBookingPaymentFunction',
      'payments.getBookingPayment',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.paymentsTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    bookingPaymentsResource.addResource('{bookingId}').addMethod('GET', new apigateway.LambdaIntegration(getBookingPaymentFn), {
      authorizer: cognitoAuth,
    });

    // POST /payments/webhook
    const webhookFn = this.createLambdaFunction(
      'PaymentWebhookFunction',
      'payments.handleWebhook',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.paymentsTable, operations: ['write'] },
        { table: tables.notificationsTable, operations: ['write'] }
      ],
      false
    );
    webhookFn.addEnvironment('STRIPE_SECRET_NAME', stripeSecret.secretName);
    stripeSecret.grantRead(webhookFn);
    paymentsResource.addResource('webhook').addMethod('POST', new apigateway.LambdaIntegration(webhookFn));
  }
}

module.exports = { HomeLinkStack };

