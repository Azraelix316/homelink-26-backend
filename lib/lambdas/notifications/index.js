const { DynamoDBClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { response, errorResponse, getUserId, getQueryParam, getPathParam, now } = require('./utils');

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE;

/**
 * GET /notifications?user_id={id}
 * Get current notifications for user
 */
async function getNotifications(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const unreadOnly = getQueryParam(event, 'unread_only', 'false') === 'true';
    const limit = parseInt(getQueryParam(event, 'limit', '50'));

    let filterExpression = '';
    const expressionAttributeValues = { ':userId': userId };

    if (unreadOnly) {
      filterExpression = 'AND #read = :false';
      expressionAttributeValues[':false'] = false;
    }

    // Get notifications
    const result = await dynamodb.query({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: expressionAttributeValues,
      FilterExpression: filterExpression ? filterExpression.substring(5) : undefined, // Remove leading AND
      ScanIndexForward: false, // Most recent first
      Limit: limit,
    }).promise();

    const notifications = result.Items || [];

    // Count unread
    const unreadCount = notifications.filter(n => !n.read).length;

    return response(200, {
      userId,
      notifications,
      totalCount: notifications.length,
      unreadCount,
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    return errorResponse(500, 'Failed to fetch notifications');
  }
}

/**
 * PATCH /notifications/{notificationId}
 * Mark notification as read
 */
async function markAsRead(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const notificationId = getPathParam(event, 'notificationId');

    if (!notificationId) {
      return errorResponse(400, 'notificationId required');
    }

    // Get notification to verify ownership
    const getResult = await dynamodb.query({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'userId = :userId AND notificationId = :notificationId',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':notificationId': notificationId,
      },
    }).promise();

    if (!getResult.Items || getResult.Items.length === 0) {
      return errorResponse(404, 'Notification not found');
    }

    const notification = getResult.Items[0];

    // Update notification
    await dynamodb.update({
      TableName: NOTIFICATIONS_TABLE,
      Key: {
        userId,
        notificationId,
      },
      UpdateExpression: 'SET #read = :true, #ua = :ua',
      ExpressionAttributeNames: { '#read': 'read', '#ua': 'updatedAt' },
      ExpressionAttributeValues: {
        ':true': true,
        ':ua': now(),
      },
    }).promise();

    // Return updated notification
    const updated = await dynamodb.get({
      TableName: NOTIFICATIONS_TABLE,
      Key: { userId, notificationId },
    }).promise();

    return response(200, updated.Item);
  } catch (error) {
    console.error('Mark as read error:', error);
    return errorResponse(500, 'Failed to mark notification as read');
  }
}

/**
 * DELETE /notifications/{notificationId}
 * Delete a notification
 */
async function deleteNotification(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    const notificationId = getPathParam(event, 'notificationId');

    if (!notificationId) {
      return errorResponse(400, 'notificationId required');
    }

    // Delete notification
    await dynamodb.delete({
      TableName: NOTIFICATIONS_TABLE,
      Key: {
        userId,
        notificationId,
      },
    }).promise();

    return response(200, { message: 'Notification deleted' });
  } catch (error) {
    console.error('Delete notification error:', error);
    return errorResponse(500, 'Failed to delete notification');
  }
}

/**
 * PATCH /notifications/read-all
 * Mark all notifications as read
 */
async function markAllAsRead(event) {
  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    // Get all unread notifications
    const result = await dynamodb.query({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      FilterExpression: '#read = :false',
      ExpressionAttributeNames: { '#read': 'read' },
    }).promise();

    const notifications = result.Items || [];

    // Update all to read
    const updatePromises = notifications.map(notification =>
      dynamodb.update({
        TableName: NOTIFICATIONS_TABLE,
        Key: {
          userId,
          notificationId: notification.notificationId,
        },
        UpdateExpression: 'SET #read = :true, #ua = :ua',
        ExpressionAttributeNames: { '#read': 'read', '#ua': 'updatedAt' },
        ExpressionAttributeValues: {
          ':true': true,
          ':ua': now(),
        },
      }).promise()
    );

    await Promise.all(updatePromises);

    return response(200, {
      message: 'All notifications marked as read',
      count: notifications.length,
    });
  } catch (error) {
    console.error('Mark all as read error:', error);
    return errorResponse(500, 'Failed to mark all notifications as read');
  }
}

module.exports = {
  getNotifications,
  markAsRead,
  deleteNotification,
  markAllAsRead,
};

