const AWS = require('aws-sdk');
const { response, errorResponse, getUserId, getBody, getPathParam, getQueryParam, nowMs, generateId } = require('./utils');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const BOOKINGS_TABLE = process.env.BOOKINGS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

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
    const limit = Math.min(Math.max(parseInt(getQueryParam(event, 'limit') || '50', 10), 1), 100);

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

    const cleanMessage = message.trim();
    if (cleanMessage.length > 5000) {
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
      message: cleanMessage,
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

    const [homeownerResult, tradieResult] = await Promise.all([
      dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'HomeownerIdIndex',
        KeyConditionExpression: 'homeownerId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise(),
      dynamodb.query({
        TableName: BOOKINGS_TABLE,
        IndexName: 'TradieIdIndex',
        KeyConditionExpression: 'tradieId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise(),
    ]);

    const bookingsById = new Map();
    [...(homeownerResult.Items || []), ...(tradieResult.Items || [])]
      .forEach(booking => bookingsById.set(booking.bookingId, booking));
    const bookings = Array.from(bookingsById.values());
    const counterpartIds = [...new Set(bookings.map(booking =>
      booking.homeownerId === userId ? booking.tradieId : booking.homeownerId
    ).filter(Boolean))];
    const peopleResult = counterpartIds.length && USERS_TABLE
      ? await dynamodb.batchGet({
          RequestItems: {
            [USERS_TABLE]: { Keys: counterpartIds.map(id => ({ userId: id })) },
          },
        }).promise()
      : { Responses: { [USERS_TABLE]: [] } };
    const people = new Map((peopleResult.Responses?.[USERS_TABLE] || [])
      .map(person => [person.userId, person]));
    const conversations = [];

    for (const booking of bookings) {
      const messagesResult = await dynamodb.query({
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: 'bookingId = :bookingId',
        ExpressionAttributeValues: { ':bookingId': booking.bookingId },
        ScanIndexForward: false,
        Limit: 1,
      }).promise();

      const latestMessage = messagesResult.Items?.[0];
      const counterpartId = booking.homeownerId === userId
        ? booking.tradieId
        : booking.homeownerId;
      const counterpart = people.get(counterpartId);

      conversations.push({
        bookingId: booking.bookingId,
        tradieId: booking.tradieId,
        homeownerId: booking.homeownerId,
        status: booking.status,
        date: booking.date || booking.bookingDate,
        startTime: booking.startTime,
        endTime: booking.endTime,
        jobType: booking.jobType,
        description: booking.description,
        counterpart: {
          userId: counterpartId,
          name: counterpart?.name || (booking.homeownerId === userId ? 'Tradie' : 'Homeowner'),
        },
        lastMessage: latestMessage?.message || '',
        lastMessageAt: latestMessage?.createdAt || booking.createdAt,
      });
    }

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
