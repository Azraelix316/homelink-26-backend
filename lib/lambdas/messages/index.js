const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, nowMs, generateId, getLimit, getUserRole } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;

/**
 * GET /messages/booking/{bookingId}
 * Get message thread for a booking
 */
async function getMessages(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    const limit = getLimit(event, 50);

    if (!bookingId) {
      return errorResponse(400, 'bookingId required');
    }

    // Verify user is part of this booking
    const bookingResult = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!bookingResult.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = bookingResult.Item;
    if (booking.homeownerId !== userId && booking.tradieId !== userId) {
      return errorResponse(403, 'Not authorized to view messages for this booking');
    }

    // Get messages
    const result = await dynamodb.query({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'bookingId = :bookingId',
      ExpressionAttributeValues: { ':bookingId': bookingId },
      ScanIndexForward: true, // Oldest first
      Limit: limit,
    }).promise();

    return response(200, {
      bookingId,
      messages: result.Items || [],
      count: result.Items?.length || 0,
    });
  } catch (error) {
    console.error('Get messages error:', error);
    return errorResponse(500, 'Failed to fetch messages');
  }
}

/**
 * POST /messages/booking/{bookingId}
 * Send a message in booking thread
 * Body: { message }
 */
async function sendMessage(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const bookingId = getPathParam(event, 'bookingId');
    const body = getBody(event);
    const { message } = body;

    if (!bookingId || !message) {
      return errorResponse(400, 'bookingId and message required');
    }

    if (typeof message !== 'string' || message.trim().length === 0) {
      return errorResponse(400, 'Message cannot be empty');
    }

    if (message.length > 5000) {
      return errorResponse(400, 'Message too long (max 5000 characters)');
    }

    // Verify user is part of this booking
    const bookingResult = await dynamodb.get({
      TableName: BOOKINGS_TABLE,
      Key: { bookingId },
    }).promise();

    if (!bookingResult.Item) {
      return errorResponse(404, 'Booking not found');
    }

    const booking = bookingResult.Item;
    if (booking.homeownerId !== userId && booking.tradieId !== userId) {
      return errorResponse(403, 'Not authorized to send messages for this booking');
    }

    // Determine sender role
    const senderRole = booking.homeownerId === userId ? 'homeowner' : 'tradie';

    // Create message
    const messageId = generateId();
    const timestamp = nowMs();
    const messageRecord = {
      bookingId,
      messageTimestamp: timestamp,
      messageId,
      userId,
      senderRole,
      message: message.trim(),
      createdAt: timestamp,
    };

    await dynamodb.put({
      TableName: MESSAGES_TABLE,
      Item: messageRecord,
    }).promise();

    return response(201, messageRecord);
  } catch (error) {
    console.error('Send message error:', error);
    return errorResponse(500, 'Failed to send message');
  }
}

/**
 * GET /messages?user_id={id}
 * Get list of conversations (one per booking) for a user
 */
async function getConversations(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    // Get all bookings for user
    const isHomeowner = getUserRole(event) === 'homeowner';
    const bookingsResult = await dynamodb.query({
      TableName: BOOKINGS_TABLE,
      IndexName: isHomeowner ? 'HomeownerIdIndex' : 'TradieIdIndex',
      KeyConditionExpression: isHomeowner ? 'homeownerId = :userId' : 'tradieId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();

    const bookings = bookingsResult.Items || [];
    const conversations = [];

    for (const booking of bookings) {
      // Get latest message for this booking
      const messagesResult = await dynamodb.query({
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: 'bookingId = :bookingId',
        ExpressionAttributeValues: { ':bookingId': booking.bookingId },
        ScanIndexForward: false,
        Limit: 1,
      }).promise();

      const latestMessage = messagesResult.Items?.[0];

      conversations.push({
        bookingId: booking.bookingId,
        tradieId: booking.tradieId,
        homeownerId: booking.homeownerId,
        status: booking.status,
        date: booking.date,
        lastMessage: latestMessage?.message || '',
        lastMessageAt: latestMessage?.createdAt || booking.createdAt,
      });
    }

    // Sort by last message time
    conversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    return response(200, {
      userId,
      conversations,
      count: conversations.length,
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    return errorResponse(500, 'Failed to fetch conversations');
  }
}

module.exports = {
  getMessages,
  sendMessage,
  getConversations,
};
