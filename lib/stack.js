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

    // Origins that may call the API from a browser or app webview: the
    // allowedOrigins context (comma-separated or a list) plus frontendUrl.
    // Any origin is allowed until one of them is set.
    this.allowedOrigins = this.getAllowedOrigins();

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'HomeLinkApi', {
      restApiName: 'HomeLink API',
      description: 'HomeLink tradies marketplace backend API',
      defaultCorsPreflightOptions: {
        allowOrigins: this.allowedOrigins.includes('*') ? apigateway.Cors.ALL_ORIGINS : this.allowedOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      // Caps request rate to limit brute force and runaway costs
      deployOptions: {
        throttlingRateLimit: Number(this.node.tryGetContext('apiRateLimit') || 100),
        throttlingBurstLimit: Number(this.node.tryGetContext('apiBurstLimit') || 200),
        // Tighter limits where abuse is cheap for an attacker: endpoints that
        // send email or check passwords, and public endpoints that scan tables
        methodOptions: {
          '/auth/register/POST': { throttlingRateLimit: 5, throttlingBurstLimit: 10 },
          '/auth/resend-code/POST': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
          '/auth/confirm/POST': { throttlingRateLimit: 5, throttlingBurstLimit: 10 },
          '/auth/login/POST': { throttlingRateLimit: 10, throttlingBurstLimit: 20 },
          '/search/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          '/trades/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          '/locations/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
        },
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

  getAllowedOrigins() {
    const configured = this.node.tryGetContext('allowedOrigins');
    const list = Array.isArray(configured) ? configured : String(configured || '').split(',');
    const frontendUrl = this.node.tryGetContext('frontendUrl');
    const origins = [...list, frontendUrl]
      .filter(origin => typeof origin === 'string')
      .map(origin => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    return origins.length ? [...new Set(origins)] : ['*'];
  }

  createLambdaFunction(name, handler, tables, cognito, requiredTables, requiresCognito, options = {}) {
    // requiresCognito: list of Cognito admin actions, e.g. ['AdminInitiateAuth'], or false
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
        ALLOWED_ORIGINS: this.allowedOrigins.join(','),
        // Stripe card fee passed on to homeowners (domestic AU cards by default).
        // Every Lambda gets it so price quotes always match what's charged.
        STRIPE_FEE_PERCENT: String(this.node.tryGetContext('stripeFeePercent') || 0.0165),
        STRIPE_FEE_FIXED: String(this.node.tryGetContext('stripeFeeFixed') || 0.30),
        ...options.environment,
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

    // Grant the Cognito admin actions this Lambda needs (array of action names)
    if (requiresCognito && requiresCognito.length) {
      fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: requiresCognito.map(action => 'cognito-idp:' + action),
        resources: [cognito.userPool.userPoolArn],
      }));
    }

    // Grant read access to any secrets this Lambda needs (e.g. Stripe keys)
    (options.secrets || []).forEach(secret => secret.grantRead(fn));

    return fn;
  }

  createAuthEndpoints(api, tables, cognito) {
    const authResource = api.root.addResource('auth');
    const registerResource = authResource.addResource('register');
    const loginResource = authResource.addResource('login');
    const meResource = authResource.addResource('me');
    const logoutResource = authResource.addResource('logout');
    const confirmResource = authResource.addResource('confirm');
    const resendCodeResource = authResource.addResource('resend-code');

    const registrationEnv = { environment: { REGISTRATION_CLIENT_ID: cognito.registrationClient.userPoolClientId } };

    // POST /auth/register
    const registerFn = this.createLambdaFunction(
      'AuthRegisterFunction',
      'auth.register',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['write'] }],
      ['DescribeUserPoolClient', 'AdminGetUser', 'AdminDeleteUser'],
      registrationEnv
    );
    registerResource.addMethod('POST', new apigateway.LambdaIntegration(registerFn));

    // POST /auth/confirm
    const confirmFn = this.createLambdaFunction(
      'AuthConfirmFunction',
      'auth.confirmRegistration',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['write'] }],
      ['DescribeUserPoolClient', 'AdminGetUser'],
      registrationEnv
    );
    confirmResource.addMethod('POST', new apigateway.LambdaIntegration(confirmFn));

    // POST /auth/resend-code
    const resendCodeFn = this.createLambdaFunction(
      'AuthResendCodeFunction',
      'auth.resendConfirmationCode',
      tables,
      cognito,
      [],
      ['DescribeUserPoolClient'],
      registrationEnv
    );
    resendCodeResource.addMethod('POST', new apigateway.LambdaIntegration(resendCodeFn));

    // POST /auth/login
    const loginFn = this.createLambdaFunction(
      'AuthLoginFunction',
      'auth.login',
      tables,
      cognito,
      [{ table: tables.usersTable, operations: ['read'] }],
      ['AdminInitiateAuth']
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

    // POST /auth/logout
    const logoutFn = this.createLambdaFunction(
      'AuthLogoutFunction',
      'auth.logout',
      tables,
      cognito,
      [],
      ['AdminUserGlobalSignOut']
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
        { table: tables.usersTable, operations: ['read', 'write'] }
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
        { table: tables.bookingsTable, operations: ['read'] }
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
        // Rescheduling re-checks availability and, for paid bookings, the price
        { table: tables.scheduleTable, operations: ['read'] },
        { table: tables.usersTable, operations: ['read'] },
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
        { table: tables.reviewsTable, operations: ['read', 'write'] },
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
        { table: tables.messagesTable, operations: ['read'] },
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
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    msgResource.addMethod('GET', new apigateway.LambdaIntegration(getConversationsFn), {
      authorizer: cognitoAuth,
    });
  }

  createPricingEndpoints(api, tables, cognitoAuth) {
    const pricingResource = api.root.addResource('pricing');

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
    // POST /pricing/estimate (public price guide)
    const estimateFn = this.createLambdaFunction(
      'EstimatePricingFunction',
      'pricing.estimatePrice',
      tables,
      { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } },
      [
        { table: tables.usersTable, operations: ['read'] }
      ],
      false
    );
    pricingResource.addResource('estimate').addMethod('POST', new apigateway.LambdaIntegration(estimateFn));

    pricingResource.addResource('breakdown').addResource('{bookingId}').addMethod('GET', new apigateway.LambdaIntegration(breakdownFn), {
      authorizer: cognitoAuth,
    });
  }

  createScheduleEndpoints(api, tables, cognitoAuth) {
    const scheduleResource = api.root.addResource('schedule');
    const tradieScheduleResource = scheduleResource.addResource('tradie');
    const meScheduleResource = scheduleResource.addResource('me');
    const unavailableScheduleResource = meScheduleResource.addResource('unavailable');

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
        { table: tables.profilesTable, operations: ['read'] }
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
    const paymentsResource = api.root.addResource('payments');
    const paymentIdResource = paymentsResource.addResource('{paymentId}');
    const bookingPaymentsResource = paymentsResource.addResource('booking');
    const connectResource = paymentsResource.addResource('connect');
    const proResource = paymentsResource.addResource('pro');

    // Stripe keys live in Secrets Manager as JSON:
    // { "secretKey": "sk_...", "webhookSecret": "whsec_...", "connectWebhookSecret": "whsec_..." }
    const stripeSecretName = this.node.tryGetContext('stripeSecretName') || 'homelink/stripe';
    const stripeSecret = secretsmanager.Secret.fromSecretNameV2(this, 'StripeSecret', stripeSecretName);
    const paymentOptions = {
      environment: {
        STRIPE_SECRET_ID: stripeSecretName,
        STRIPE_CURRENCY: this.node.tryGetContext('stripeCurrency') || 'aud',
        FRONTEND_URL: this.node.tryGetContext('frontendUrl') || 'http://localhost:3000',
        // HomeLink Pro: Stripe Price IDs per cycle, or inline prices (A$149/month, A$1,490/year)
        PRO_MONTHLY_PRICE_ID: this.node.tryGetContext('proMonthlyPriceId') || '',
        PRO_ANNUAL_PRICE_ID: this.node.tryGetContext('proAnnualPriceId') || '',
        PRO_CURRENCY: this.node.tryGetContext('proCurrency') || 'aud',
        PRO_MONTHLY_PRICE_CENTS: String(this.node.tryGetContext('proMonthlyPriceCents') || 14900),
        PRO_ANNUAL_PRICE_CENTS: String(this.node.tryGetContext('proAnnualPriceCents') || 149000),
      },
      secrets: [stripeSecret],
    };
    const noCognito = { userPool: { userPoolId: '', userPoolArn: '' }, userPoolClient: { userPoolClientId: '' } };

    // POST /payments/create-payment-intent
    const createIntentFn = this.createLambdaFunction(
      'CreatePaymentIntentFunction',
      'payments.createPaymentIntent',
      tables,
      noCognito,
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.usersTable, operations: ['read'] }
      ],
      false,
      paymentOptions
    );
    paymentsResource.addResource('create-payment-intent').addMethod('POST', new apigateway.LambdaIntegration(createIntentFn), {
      authorizer: cognitoAuth,
    });

    // POST /payments/confirm-payment
    const confirmPaymentFn = this.createLambdaFunction(
      'ConfirmPaymentFunction',
      'payments.confirmPayment',
      tables,
      noCognito,
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.paymentsTable, operations: ['read', 'write'] },
        { table: tables.notificationsTable, operations: ['write'] }
      ],
      false,
      paymentOptions
    );
    paymentsResource.addResource('confirm-payment').addMethod('POST', new apigateway.LambdaIntegration(confirmPaymentFn), {
      authorizer: cognitoAuth,
    });

    // GET /payments/{paymentId}
    const getPaymentFn = this.createLambdaFunction(
      'GetPaymentFunction',
      'payments.getPayment',
      tables,
      noCognito,
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
      noCognito,
      [
        { table: tables.paymentsTable, operations: ['read'] },
        { table: tables.bookingsTable, operations: ['read'] }
      ],
      false
    );
    bookingPaymentsResource.addResource('{bookingId}').addMethod('GET', new apigateway.LambdaIntegration(getBookingPaymentFn), {
      authorizer: cognitoAuth,
    });

    // POST /payments/connect/onboard - tradie creates/continues Stripe Connect onboarding
    const connectOnboardFn = this.createLambdaFunction(
      'ConnectOnboardFunction',
      'payments.connectOnboard',
      tables,
      noCognito,
      [
        { table: tables.usersTable, operations: ['read', 'write'] }
      ],
      false,
      paymentOptions
    );
    connectResource.addResource('onboard').addMethod('POST', new apigateway.LambdaIntegration(connectOnboardFn), {
      authorizer: cognitoAuth,
    });

    // GET /payments/connect/status - tradie's Stripe Connect account status
    const connectStatusFn = this.createLambdaFunction(
      'ConnectStatusFunction',
      'payments.connectStatus',
      tables,
      noCognito,
      [
        { table: tables.usersTable, operations: ['read', 'write'] }
      ],
      false,
      paymentOptions
    );
    connectResource.addResource('status').addMethod('GET', new apigateway.LambdaIntegration(connectStatusFn), {
      authorizer: cognitoAuth,
    });

    // HomeLink Pro subscription endpoints (tradies)
    [
      // [name, handler, path, method, calls Stripe]
      ['ProSubscribeFunction', 'payments.subscribePro', 'subscribe', 'POST', true],
      ['ProPortalFunction', 'payments.proBillingPortal', 'portal', 'POST', true],
      ['ProStatusFunction', 'payments.proStatus', 'status', 'GET', false],
    ].forEach(([name, handler, path, method, callsStripe]) => {
      const fn = this.createLambdaFunction(
        name,
        handler,
        tables,
        noCognito,
        [
          // Status only reads the user record
          { table: tables.usersTable, operations: callsStripe ? ['read', 'write'] : ['read'] }
        ],
        false,
        callsStripe ? paymentOptions : { environment: paymentOptions.environment }
      );
      proResource.addResource(path).addMethod(method, new apigateway.LambdaIntegration(fn), {
        authorizer: cognitoAuth,
      });
    });

    // POST /payments/webhook - called by Stripe, authenticated by signature
    const webhookFn = this.createLambdaFunction(
      'PaymentWebhookFunction',
      'payments.handleWebhook',
      tables,
      noCognito,
      [
        { table: tables.bookingsTable, operations: ['read', 'write'] },
        { table: tables.paymentsTable, operations: ['read', 'write'] },
        { table: tables.notificationsTable, operations: ['write'] },
        { table: tables.usersTable, operations: ['write'] }
      ],
      false,
      paymentOptions
    );
    paymentsResource.addResource('webhook').addMethod('POST', new apigateway.LambdaIntegration(webhookFn));
  }
}

module.exports = { HomeLinkStack };

