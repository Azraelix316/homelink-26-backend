# HomeLink Backend - AWS CDK Infrastructure

A complete serverless backend for HomeLink tradies marketplace built with AWS CDK, featuring DynamoDB, Lambda, API Gateway, and Cognito authentication.

> **Start with [DEVELOPMENT.md](DEVELOPMENT.md)** for setup, configuration and the current architecture, and [DEPLOY_PLAN.md](DEPLOY_PLAN.md) before deploying. Parts of this README and the older summary documents (`IMPLEMENTATION_SUMMARY.md`, `BACKEND_ANALYSIS.md`, `INDEX.md`) predate payments, email verification and the security review.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (REST API)                   │
│  - Cognito User Pool Authorization                         │
│  - CORS enabled for frontend integration                   │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├─────────────────────────────────────────┐
                 │                                         │
        ┌────────▼────────┐                    ┌──────────▼──────┐
        │  Lambda Layer 1 │                    │  Lambda Layer 2 │
        │                 │                    │                 │
        │ • Auth          │                    │ • Availability  │
        │ • Profiles      │                    │ • Bookings      │
        │ • Pricing       │                    │ • Reviews       │
        │ • Search        │                    │ • Messages      │
        │ • Notifications │                    │ • Schedule      │
        └────────┬────────┘                    └──────────┬──────┘
                 │                                        │
                 └────────────┬─────────────────────────┬─┘
                              │                         │
                    ┌─────────▼──────────────────────────▼─────┐
                    │         DynamoDB Tables                 │
                    │  (Pay-per-request billing mode)          │
                    │                                          │
                    │ • Users (with GSI: Email, Role)          │
                    │ • Bookings (with GSI: Tradie, Owner)     │
                    │ • Reviews (with GSI: Tradie, Booking)    │
                    │ • Messages (with GSI: User)              │
                    │ • Schedule (Tradie working hours)        │
                    │ • Profiles (Tradie profile data)         │
                    │ • Notifications (User notifications)     │
                    └──────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────────┐
                    │  Cognito User Pool     │
                    │  & Identity Pool       │
                    │                        │
                    │ • User registration    │
                    │ • Authentication       │
                    │ • Custom attributes    │
                    └────────────────────────┘
```

## Features Implemented

### 1. Authentication (`/auth/*`)
- **POST /auth/register** - Register new user (tradie or homeowner)
- **POST /auth/login** - Authenticate with email/password
- **GET /auth/me** - Get current user profile (requires auth)
- **POST /auth/logout** - Logout user (invalidate session)

### 2. Profiles (`/profiles/*`)
- **GET /profiles/tradie/{tradieId}** - Get tradie profile with reviews and stats
- **GET /profiles/homeowner/{homeownerId}** - Get homeowner profile
- **PATCH /profiles/me** - Update own profile (name, location, hourly rate, bio, etc.)
- **POST /profiles/tradie** - Register as tradie during onboarding

### 3. Availability (`/availability/*`)
- **GET /availability/tradie/{tradieId}?date={YYYY-MM-DD}** - Get hourly available slots
- **GET /availability/tradie/{tradieId}?from={date}&to={date}** - Get availability range
- **POST /availability/check** - Check if specific time slot is available

### 4. Bookings (`/bookings/*`)
- **POST /bookings** - Create new booking (with availability validation)
- **GET /bookings?user_id={id}&role={homeowner|tradie}** - Get user's bookings
- **GET /bookings/{bookingId}** - Get booking details
- **PATCH /bookings/{bookingId}** - Update booking status (accept/decline/complete/cancel)

### 5. Reviews (`/reviews/*`)
- **POST /reviews** - Create review for completed booking
- **GET /reviews/tradie/{tradieId}** - Get all reviews for tradie + rating stats
- **GET /reviews?booking_id={id}** - Get review for specific booking (if exists)
- **GET /reviews/{reviewId}** - Get specific review details

### 6. Messages (`/messages/*`)
- **GET /messages/booking/{bookingId}** - Get message thread for booking
- **POST /messages/booking/{bookingId}** - Send message in thread
- **GET /messages?user_id={id}** - Get user's conversations (one per booking)

### 7. Pricing (`/pricing/*`)
- **POST /pricing/calculate** - Calculate pricing breakdown (commission math)
- **GET /pricing/breakdown/{bookingId}** - Get pricing for specific booking

### 8. Schedule (`/schedule/*`)
- **GET /schedule/tradie/{tradieId}** - Get tradie's working hours and days off
- **PATCH /schedule/me** - Update own working hours
- **POST /schedule/me/unavailable** - Mark day as unavailable
- **DELETE /schedule/me/unavailable/{date}** - Remove day off

### 9. Search (`/search*`, `/trades`, `/locations`)
- **GET /search?trade={type}&location={suburb}&rating_min={floor}** - Search tradies with filters
- **GET /trades** - Get list of available trade types
- **GET /locations** - Get list of available work locations

### 10. Notifications (`/notifications/*`)
- **GET /notifications?user_id={id}** - Get user's notifications
- **PATCH /notifications/{notificationId}** - Mark notification as read
- **DELETE /notifications/{notificationId}** - Delete notification
- **PATCH /notifications/read-all** - Mark all as read

## Prerequisites

- **AWS Account** with credentials configured
- **Node.js** 18+ and npm
- **AWS CDK** CLI: `npm install -g aws-cdk`

## Installation

1. **Clone and navigate to project:**
   ```bash
   cd c:\Users\User\homelink-26-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Bootstrap CDK (first time only):**
   ```bash
   cdk bootstrap
   ```

## Deployment

### Synth CDK to CloudFormation template:
```bash
npm run cdk:synth
```

### Review changes before deployment:
```bash
npm run cdk:diff
```

### Deploy to AWS:
```bash
npm run cdk:deploy
```

**Note:** This command will deploy everything - DynamoDB tables, Lambda functions, API Gateway, and Cognito. No deployment is performed yet as per your request.

### To see deployment status:
```bash
aws cloudformation describe-stack-resources --stack-name HomeLinkBackendStack
```

## Environment Variables

Lambda functions are automatically configured with:

```
USERS_TABLE              → DynamoDB Users table name
BOOKINGS_TABLE           → DynamoDB Bookings table name
REVIEWS_TABLE            → DynamoDB Reviews table name
MESSAGES_TABLE           → DynamoDB Messages table name
SCHEDULE_TABLE           → DynamoDB Schedule table name
PROFILES_TABLE           → DynamoDB Profiles table name
NOTIFICATIONS_TABLE      → DynamoDB Notifications table name
USER_POOL_ID             → Cognito User Pool ID
CLIENT_ID                → Cognito App Client ID
```

## Project Structure

```
homelink-26-backend/
├── lib/
│   ├── main.js                 # CDK App entry point
│   ├── stack.js                # Main CDK Stack (wires everything)
│   ├── tables.js               # DynamoDB table definitions
│   ├── cognito.js              # Cognito User Pool setup
│   ├── utils.js                # Shared utilities
│   ├── business-logic.js       # Core business logic (availability, pricing)
│   └── lambdas/
│       ├── auth.js             # Authentication endpoints
│       ├── profiles.js         # Profile management
│       ├── availability.js     # Availability checking
│       ├── bookings.js         # Booking management
│       ├── reviews.js          # Reviews and ratings
│       ├── messages.js         # Messaging system
│       ├── pricing.js          # Pricing calculations
│       ├── schedule.js         # Tradie schedule
│       ├── search.js           # Search and filtering
│       └── notifications.js    # User notifications
├── package.json                # Dependencies
├── cdk.json                    # CDK configuration
└── README.md                   # This file
```

## Database Schema

### Users Table
```json
{
  "userId": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "role": "tradie|homeowner",
  "location": "Sydney",
  "hourlyRate": 75.00,
  "trade": "Plumber",
  "yearsExperience": 5,
  "bio": "Experienced plumber",
  "serviceTypes": ["Leaks", "Installation"],
  "photoGallery": [],
  "averageRating": 4.5,
  "reviewCount": 12,
  "createdAt": 1691000000,
  "updatedAt": 1691000000
}
```

### Bookings Table
```json
{
  "bookingId": "uuid",
  "tradieId": "uuid",
  "homeownerId": "uuid",
  "date": "2024-08-15",
  "startTime": "09:00",
  "endTime": "11:00",
  "jobType": "Plumbing",
  "description": "Fix kitchen sink",
  "status": "pending|accepted|declined|completed|cancelled|reviewed",
  "createdAt": 1691000000,
  "updatedAt": 1691000000
}
```

### Reviews Table
```json
{
  "reviewId": "uuid",
  "bookingId": "uuid",
  "tradieId": "uuid",
  "homeownerId": "uuid",
  "rating": 5,
  "comment": "Great work!",
  "createdAt": 1691000000
}
```

### Messages Table
```json
{
  "bookingId": "uuid",
  "messageTimestamp": 1691000000000,
  "messageId": "uuid",
  "userId": "uuid",
  "senderRole": "tradie|homeowner",
  "message": "Message text",
  "createdAt": 1691000000000
}
```

### Schedule Table
```json
{
  "tradieId": "uuid",
  "scheduleType": "working-hours|unavailable-YYYY-MM-DD",
  "workingHours": {
    "Monday": { "start": "09:00", "end": "17:00" },
    "Tuesday": { "start": "09:00", "end": "17:00" },
    ...
  },
  "travelBuffer": 30,
  "createdAt": 1691000000
}
```

## API Authentication

All protected endpoints require Cognito authorization. Include the authorization header:

```
Authorization: Bearer <idToken>
```

### Example: Get Current User
```bash
curl -X GET https://api.homelink.example.com/auth/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json"
```

### Example: Create Booking
```bash
curl -X POST https://api.homelink.example.com/bookings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tradieId": "123e4567-e89b-12d3-a456-426614174000",
    "date": "2024-08-20",
    "startTime": "10:00",
    "endTime": "12:00",
    "jobType": "Plumbing",
    "description": "Fix leaking tap"
  }'
```

## Business Logic

### Availability Engine
- Checks working hours (Monday-Friday 9am-5pm by default)
- Marks days off as unavailable
- Prevents double bookings with configurable travel buffer (default 30 mins)
- Returns hourly slots with availability status

### Pricing Calculations
- Subtotal = hourlyRate × hours
- Tradie commission: 10% (removed if HomeLink Pro)
- Homeowner fee: 5% service charge
- Tradie earns: subtotal - commission
- Homeowner pays: subtotal + fee

### Booking Status Flow
```
pending → accepted → completed → reviewed
       ↘ declined
       ↘ cancelled
```

## Costs

With **pay-per-request** DynamoDB billing:
- Free tier: 25 write units, 100 read units per month
- Beyond: $1.25 per million write units, $0.25 per million read units

Lambda pricing: $0.20 per million requests + duration charges

API Gateway: $3.50 per million API calls

## Cleanup

To destroy all resources and avoid costs:

```bash
npm run cdk:destroy
```

**Warning:** This will delete all data in DynamoDB tables. Export data before destroying.

## Next Steps (NOT YET IMPLEMENTED)

1. **Frontend Integration** - Connect React app to API endpoints
2. **Payment Processing** - Integrate Stripe for HomeLink Pro subscriptions
3. **Real-time Features** - Add WebSocket support for live chat
4. **Email Notifications** - Send transactional emails via SES
5. **Image Storage** - Add S3 integration for tradie photos
6. **Analytics** - CloudWatch dashboards and metrics
7. **Monitoring** - Set up alarms for Lambda errors and DynamoDB throttling

## Support

For issues or questions, refer to:
- AWS CDK Documentation: https://docs.aws.amazon.com/cdk/
- DynamoDB Guide: https://docs.aws.amazon.com/dynamodb/
- Lambda Best Practices: https://docs.aws.amazon.com/lambda/
