const cdk = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');

/**
 * Create all DynamoDB tables needed for HomeLink backend
 */
function createTables(stack) {
  // Users table - stores both tradies and homeowners
  const usersTable = new dynamodb.Table(stack, 'UsersTable', {
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  usersTable.addGlobalSecondaryIndex({
    indexName: 'EmailIndex',
    partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
  });

  usersTable.addGlobalSecondaryIndex({
    indexName: 'RoleIndex',
    partitionKey: { name: 'role', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
  });

  // Bookings table
  const bookingsTable = new dynamodb.Table(stack, 'BookingsTable', {
    partitionKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  bookingsTable.addGlobalSecondaryIndex({
    indexName: 'TradieIdIndex',
    partitionKey: { name: 'tradieId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'bookingDate', type: dynamodb.AttributeType.STRING },
  });

  bookingsTable.addGlobalSecondaryIndex({
    indexName: 'HomeownerIdIndex',
    partitionKey: { name: 'homeownerId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
  });

  bookingsTable.addGlobalSecondaryIndex({
    indexName: 'StatusIndex',
    partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'bookingDate', type: dynamodb.AttributeType.STRING },
  });

  // Reviews table
  const reviewsTable = new dynamodb.Table(stack, 'ReviewsTable', {
    partitionKey: { name: 'reviewId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  reviewsTable.addGlobalSecondaryIndex({
    indexName: 'TradieIdIndex',
    partitionKey: { name: 'tradieId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
  });

  reviewsTable.addGlobalSecondaryIndex({
    indexName: 'BookingIdIndex',
    partitionKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
  });

  // Messages table
  const messagesTable = new dynamodb.Table(stack, 'MessagesTable', {
    partitionKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'messageTimestamp', type: dynamodb.AttributeType.NUMBER },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  messagesTable.addGlobalSecondaryIndex({
    indexName: 'UserIdIndex',
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'messageTimestamp', type: dynamodb.AttributeType.NUMBER },
  });

  // Tradie Schedule table
  const scheduleTable = new dynamodb.Table(stack, 'ScheduleTable', {
    partitionKey: { name: 'tradieId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'scheduleType', type: dynamodb.AttributeType.STRING }, // 'working-hours' or 'unavailable-{date}'
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  // Tradie Profiles table (denormalized data for faster queries)
  const profilesTable = new dynamodb.Table(stack, 'ProfilesTable', {
    partitionKey: { name: 'tradieId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  profilesTable.addGlobalSecondaryIndex({
    indexName: 'TradeIndex',
    partitionKey: { name: 'trade', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'rating', type: dynamodb.AttributeType.NUMBER },
  });

  profilesTable.addGlobalSecondaryIndex({
    indexName: 'LocationIndex',
    partitionKey: { name: 'location', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'rating', type: dynamodb.AttributeType.NUMBER },
  });

  // Notifications table (computed on-demand, but can cache results)
  const notificationsTable = new dynamodb.Table(stack, 'NotificationsTable', {
    partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: true,
  });

  return {
    usersTable,
    bookingsTable,
    reviewsTable,
    messagesTable,
    scheduleTable,
    profilesTable,
    notificationsTable,
  };
}

module.exports = { createTables };
