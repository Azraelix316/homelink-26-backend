# HomeLink Backend - Complete API & Cognito Documentation

## Overview
- **API Base URL**: `https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod`
- **Region**: `ap-southeast-2` (Sydney)
- **Total Endpoints**: 35 API Gateway endpoints
- **Lambda Functions**: 23 functions across 10 feature areas
- **Authentication**: AWS Cognito User Pool

---

## Cognito Authentication Setup

### User Pool Details
- **User Pool ID**: `ap-southeast-2_V2d9XFJ0Y`
- **User Pool Client ID**: `7t9n91l9kj3jqlism8v9nupor`
- **Client Name**: `homelink-app-client`
- **Auth Flows Enabled**:
  - `ADMIN_NO_SRP_AUTH` - Server-side initiated login
  - `USER_PASSWORD_AUTH` - Direct username/password flow

### User Roles
- **tradie** - Service providers (electrician, plumber, etc.)
- **homeowner** - Service requesters

### Custom Attributes
- `custom:role` - User type (tradie/homeowner)
- `custom:userId` - Internal user ID

### Password Policy
- Minimum 8 characters
- Must contain digits
- Must contain lowercase letters
- Symbols not required
- Uppercase not required

---

## API Endpoints (35 total)

### 1. Authentication Endpoints (4 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| POST | `/auth/register` | `auth.register` | ❌ | Register new user (tradie or homeowner) |
| POST | `/auth/login` | `auth.login` | ❌ | Authenticate user, returns JWT tokens |
| GET | `/auth/me` 🔒 | `auth.getMe` | ✅ | Get current authenticated user profile |
| POST | `/auth/logout` 🔒 | `auth.logout` | ✅ | Logout current user |

**Auth Endpoint Details:**

**POST /auth/register**
```json
{
  "email": "tradie@example.com",
  "password": "SecurePass123",
  "role": "tradie",              // or "homeowner"
  "name": "John Smith",
  "location": "Sydney",          // optional
  "hourlyRate": 75              // required if role="tradie"
}
```
Returns: `{ userId, email, name, role, message }`

**POST /auth/login**
```json
{
  "email": "tradie@example.com",
  "password": "SecurePass123"
}
```
Returns: `{ accessToken, idToken, refreshToken, expiresIn, user }`

---

### 2. Profile Endpoints (4 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/profiles/tradie/{tradieId}` | `profiles.getTradieProfile` | ❌ | Fetch tradie's public profile |
| GET | `/profiles/homeowner/{homeownerId}` | `profiles.getHomeownerProfile` | ❌ | Fetch homeowner's public profile |
| PATCH | `/profiles/me` 🔒 | `profiles.updateProfile` | ✅ | Update current user's profile |
| POST | `/profiles/tradie` 🔒 | `profiles.registerTradie` | ✅ | Register as tradie (upgrade homeowner account) |

**Profile Update Request:**
```json
{
  "name": "John Smith",
  "trade": "Plumbing",
  "bio": "Professional plumber with 10 years experience",
  "yearsExperience": 10,
  "serviceTypes": ["repair", "installation"],
  "hourlyRate": 85,
  "photoGallery": ["url1", "url2"]
}
```

---

### 3. Availability Endpoints (2 endpoints)

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/availability/tradie/{tradieId}` | `availability.getAvailability` | ❌ | Get tradie's availability calendar |
| POST | `/availability/check` | `availability.checkAvailability` | ❌ | Check if tradie is available for date range |

**Check Availability Request:**
```json
{
  "tradieId": "user-123",
  "startDate": "2026-08-15",
  "endDate": "2026-08-20"
}
```

---

### 4. Booking Endpoints (4 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| POST | `/bookings` 🔒 | `bookings.createBooking` | ✅ | Create new booking request |
| GET | `/bookings` 🔒 | `bookings.getUserBookings` | ✅ | Get user's bookings (as tradie or homeowner) |
| GET | `/bookings/{bookingId}` | `bookings.getBooking` | ❌ | Get specific booking details |
| PATCH | `/bookings/{bookingId}` 🔒 | `bookings.updateBooking` | ✅ | Update booking status (accept/decline/complete) |

**Booking Statuses:**
- `pending` - Awaiting tradie response
- `confirmed` - Tradie accepted
- `in_progress` - Work started
- `completed` - Work done
- `cancelled` - Cancelled by either party

**Create Booking Request:**
```json
{
  "tradieId": "tradie-123",
  "startDate": "2026-08-20",
  "endDate": "2026-08-21",
  "description": "Bathroom plumbing repair",
  "location": "Sydney NSW 2000",
  "budget": 500
}
```

**Update Booking Request:**
```json
{
  "status": "confirmed",    // or "in_progress", "completed", "cancelled"
  "notes": "Starting tomorrow"
}
```

---

### 5. Review Endpoints (3 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| POST | `/reviews` 🔒 | `reviews.createReview` | ✅ | Create review for tradie |
| GET | `/reviews/tradie/{tradieId}` | `reviews.getTradieReviews` | ❌ | Get all reviews for tradie |
| GET | `/reviews` | `reviews.getBookingReview` | ❌ | Get review for specific booking |

**Create Review Request:**
```json
{
  "bookingId": "booking-123",
  "tradieId": "tradie-123",
  "rating": 5,
  "comment": "Excellent work, very professional!"
}
```

**Query Parameters for GET /reviews:**
```
?bookingId=booking-123
```

---

### 6. Message Endpoints (3 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/messages/booking/{bookingId}` 🔒 | `messages.getMessages` | ✅ | Get conversation for booking |
| POST | `/messages/booking/{bookingId}` 🔒 | `messages.sendMessage` | ✅ | Send message in booking conversation |
| GET | `/messages` 🔒 | `messages.getConversations` | ✅ | Get all conversations for user |

**Send Message Request:**
```json
{
  "message": "What time should I arrive tomorrow?"
}
```

**Response:**
```json
{
  "messageId": "msg-123",
  "bookingId": "booking-123",
  "senderId": "user-123",
  "message": "What time should I arrive tomorrow?",
  "createdAt": "2026-08-15T10:30:00Z"
}
```

---

### 7. Pricing Endpoints (2 endpoints)

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| POST | `/pricing/calculate` | `pricing.calculatePrice` | ❌ | Calculate estimated price for job |
| GET | `/pricing/breakdown/{bookingId}` | `pricing.getPricingBreakdown` | ❌ | Get detailed price breakdown for booking |

**Calculate Price Request:**
```json
{
  "tradieId": "tradie-123",
  "hoursEstimated": 3,
  "serviceType": "repair"
}
```

**Response:**
```json
{
  "basePrice": 225,
  "fees": 22.50,
  "tax": 24.75,
  "total": 272.25
}
```

---

### 8. Schedule Endpoints (4 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/schedule/tradie/{tradieId}` | `schedule.getSchedule` | ❌ | Get tradie's schedule/availability |
| PATCH | `/schedule/me` 🔒 | `schedule.updateSchedule` | ✅ | Update own working hours |
| POST | `/schedule/me/unavailable` 🔒 | `schedule.markUnavailable` | ✅ | Mark date as unavailable (vacation, etc.) |
| DELETE | `/schedule/me/unavailable/{date}` 🔒 | `schedule.removeUnavailable` | ✅ | Remove unavailable date |

**Update Schedule Request:**
```json
{
  "mondayStart": "08:00",
  "mondayEnd": "17:00",
  "tuesdayStart": "08:00",
  "tuesdayEnd": "17:00",
  "wednesdayStart": "08:00",
  "wednesdayEnd": "17:00",
  "thursdayStart": "08:00",
  "thursdayEnd": "17:00",
  "fridayStart": "08:00",
  "fridayEnd": "17:00",
  "saturdayStart": null,
  "saturdayEnd": null,
  "sundayStart": null,
  "sundayEnd": null
}
```

**Mark Unavailable Request:**
```json
{
  "startDate": "2026-08-25",
  "endDate": "2026-09-01",
  "reason": "On holiday"
}
```

---

### 9. Search Endpoints (3 endpoints)

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/search` | `search.searchTradies` | ❌ | Search tradies by location, trade, rating |
| GET | `/trades` | `search.getTrades` | ❌ | Get list of available trades |
| GET | `/locations` | `search.getLocations` | ❌ | Get list of service locations |

**Search Query Parameters:**
```
GET /search?trade=plumbing&location=Sydney&minRating=4&pageSize=20&page=1
```

**Response:**
```json
{
  "tradies": [
    {
      "userId": "tradie-123",
      "name": "John Smith",
      "trade": "Plumbing",
      "location": "Sydney",
      "hourlyRate": 85,
      "rating": 4.8,
      "reviewCount": 42,
      "yearsExperience": 10
    }
  ],
  "total": 152,
  "page": 1,
  "pageSize": 20
}
```

---

### 10. Notification Endpoints (4 endpoints)
Protected endpoints marked with 🔒

| Method | Path | Handler | Auth | Purpose |
|--------|------|---------|------|---------|
| GET | `/notifications` 🔒 | `notifications.getNotifications` | ✅ | Get user's notifications |
| PATCH | `/notifications/{notificationId}` 🔒 | `notifications.markAsRead` | ✅ | Mark notification as read |
| DELETE | `/notifications/{notificationId}` 🔒 | `notifications.deleteNotification` | ✅ | Delete notification |
| PATCH | `/notifications/read-all` 🔒 | `notifications.markAllAsRead` | ✅ | Mark all notifications as read |

**Notification Types:**
- `booking_request` - New booking request
- `booking_accepted` - Booking accepted by tradie
- `booking_completed` - Booking marked complete
- `review_posted` - Review left for tradie
- `message_received` - New message in conversation

---

## DynamoDB Tables (7 total)

### Table Structure

| Table Name | Primary Key | GSI | Billing | Purpose |
|------------|-------------|-----|---------|---------|
| `Users` | `userId` | `email-index` | Pay-per-request | User profiles (tradies & homeowners) |
| `Bookings` | `bookingId` | `homeownerId-createdAt`, `tradieId-status` | Pay-per-request | Booking requests |
| `Reviews` | `reviewId` | `tradieId-rating`, `bookingId-index` | Pay-per-request | Reviews for tradies |
| `Messages` | `messageId` | `bookingId-createdAt` | Pay-per-request | Booking conversations |
| `Schedule` | `tradieId` | `tradieId-date` | Pay-per-request | Tradie availability |
| `Profiles` | `userId` | `trade-location` | Pay-per-request | Extended profile data |
| `Notifications` | `notificationId` | `userId-createdAt` | Pay-per-request | User notifications |

---

## Lambda Functions (23 total)

### Auth Module (4 functions)
- `auth.register` - User registration
- `auth.login` - User authentication
- `auth.getMe` - Current user profile
- `auth.logout` - Logout user

### Profiles Module (4 functions)
- `profiles.getTradieProfile` - Get tradie profile
- `profiles.getHomeownerProfile` - Get homeowner profile
- `profiles.updateProfile` - Update user profile
- `profiles.registerTradie` - Register as tradie

### Availability Module (2 functions)
- `availability.getAvailability` - Get tradie availability
- `availability.checkAvailability` - Check date availability

### Bookings Module (4 functions)
- `bookings.createBooking` - Create booking
- `bookings.getUserBookings` - List user bookings
- `bookings.getBooking` - Get booking details
- `bookings.updateBooking` - Update booking status

### Reviews Module (3 functions)
- `reviews.createReview` - Create review
- `reviews.getTradieReviews` - Get tradie reviews
- `reviews.getBookingReview` - Get booking review

### Messages Module (3 functions)
- `messages.getMessages` - Get booking messages
- `messages.sendMessage` - Send message
- `messages.getConversations` - List conversations

### Pricing Module (2 functions)
- `pricing.calculatePrice` - Calculate estimated price
- `pricing.getPricingBreakdown` - Get price breakdown

### Schedule Module (4 functions)
- `schedule.getSchedule` - Get tradie schedule
- `schedule.updateSchedule` - Update working hours
- `schedule.markUnavailable` - Mark dates unavailable
- `schedule.removeUnavailable` - Remove unavailable date

### Search Module (3 functions)
- `search.searchTradies` - Search for tradies
- `search.getTrades` - Get available trades
- `search.getLocations` - Get service locations

### Notifications Module (4 functions)
- `notifications.getNotifications` - List notifications
- `notifications.markAsRead` - Mark as read
- `notifications.deleteNotification` - Delete notification
- `notifications.markAllAsRead` - Mark all as read

---

## CORS Configuration

All endpoints support CORS with the following settings:
- **Allowed Origins**: `*` (All origins)
- **Allowed Methods**: GET, POST, PATCH, DELETE, PUT, HEAD, OPTIONS
- **Allowed Headers**: `*` (All headers)

---

## Environment Variables (Set on all Lambda functions)

```
USERS_TABLE=Users
BOOKINGS_TABLE=Bookings
REVIEWS_TABLE=Reviews
MESSAGES_TABLE=Messages
SCHEDULE_TABLE=Schedule
PROFILES_TABLE=Profiles
NOTIFICATIONS_TABLE=Notifications
USER_POOL_ID=ap-southeast-2_V2d9XFJ0Y
CLIENT_ID=7t9n91l9kj3jqlism8v9nupor
```

---

## Lambda Function Configuration

- **Runtime**: Node.js 18.x
- **Memory**: 256 MB
- **Timeout**: 30 seconds
- **Execution Role**: HomeLinkLambdaRole

### IAM Permissions
- Full read/write access to all 7 DynamoDB tables
- Cognito User Pool permissions:
  - `cognito-idp:AdminCreateUser`
  - `cognito-idp:AdminSetUserPassword`
  - `cognito-idp:AdminInitiateAuth`
  - `cognito-idp:ListUsers`

---

## Example Requests

### 1. Register User
```bash
curl -X POST https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "tradie@example.com",
    "password": "SecurePass123",
    "role": "tradie",
    "name": "John Smith",
    "location": "Sydney",
    "hourlyRate": 75
  }'
```

### 2. Login User
```bash
curl -X POST https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "tradie@example.com",
    "password": "SecurePass123"
  }'
```

### 3. Get Current User Profile (Authenticated)
```bash
curl -X GET https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/auth/me \
  -H "Authorization: Bearer {idToken}"
```

### 4. Search Tradies
```bash
curl -X GET "https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/search?trade=plumbing&location=Sydney&minRating=4"
```

### 5. Create Booking (Authenticated)
```bash
curl -X POST https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/bookings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {idToken}" \
  -d '{
    "tradieId": "tradie-123",
    "startDate": "2026-08-20",
    "endDate": "2026-08-21",
    "description": "Bathroom plumbing repair",
    "location": "Sydney NSW 2000",
    "budget": 500
  }'
```

---

## Error Responses

All endpoints return standardized error responses:

```json
{
  "statusCode": 400,
  "body": {
    "error": "Error message here"
  }
}
```

Common HTTP Status Codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (invalid/missing auth)
- `404` - Not Found
- `409` - Conflict (e.g., user already exists)
- `500` - Server Error

---

## Deployment Info

- **Stack Name**: HomeLinkBackendStack
- **Stack ARN**: `arn:aws:cloudformation:ap-southeast-2:731372489924:stack/HomeLinkBackendStack/662fd9f0-931e-11f1-a790-021c5f65461b`
- **Region**: `ap-southeast-2` (Sydney)
- **AWS Account ID**: `731372489924`
- **Deployment Command**: `npm run cdk:deploy --profile homelink`

---

## Next Steps for Frontend Integration

1. **Install AWS Cognito SDK**: `npm install amazon-cognito-identity-js`
2. **Configure Cognito Client**:
   - User Pool ID: `ap-southeast-2_V2d9XFJ0Y`
   - Client ID: `7t9n91l9kj3jqlism8v9nupor`
   - Region: `ap-southeast-2`
3. **API Endpoint**: `https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod`
4. **Add auth tokens to requests**: Include `Authorization: Bearer {idToken}` header for protected endpoints

---

Generated: August 8, 2026
