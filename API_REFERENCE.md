# HomeLink API Reference

Complete API endpoint documentation with request/response examples.

## Base URL
```
https://{api-gateway-endpoint}
```

## Authentication

All endpoints marked with 🔒 require Cognito authorization:

```bash
Authorization: Bearer {idToken}
```

---

## Auth Endpoints

### Registration and email verification

New accounts must prove they own their email address before they can log in:

1. `POST /auth/register` creates the account in an **unverified** state and Cognito emails a 6-digit code (valid for 24 hours).
2. `POST /auth/confirm` with that code verifies the address and activates the account.
3. `POST /auth/login` works from then on. Before that it returns **403** with `"code": "EMAIL_NOT_VERIFIED"`; send the user to the code screen and offer `POST /auth/resend-code`.

Registering an address whose earlier registration was never confirmed replaces that pending registration (and its old code), so nobody can lock an email address they don't own. A confirmed account is never replaced (409).

The `role` (`tradie` / `homeowner`) and `userId` are set by the backend at registration and cannot be changed by the client afterwards. Tradies don't appear in search until they've verified.

### Register User
**POST** `/auth/register`

Start registration for a homeowner or tradie account. Sends a verification code to `email`.

**Request:**
```json
{
  "email": "john@example.com",
  "password": "SecurePass123",
  "role": "tradie",
  "name": "John Smith",
  "location": "Sydney",
  "hourlyRate": 75.00
}
```

Passwords need at least 8 characters, including a lowercase letter and a digit.

**Response (201):**
```json
{
  "userId": "123e4567-e89b-12d3-a456-426614174000",
  "email": "john@example.com",
  "name": "John Smith",
  "role": "tradie",
  "emailVerified": false,
  "codeDeliveryDestination": "j***@e***",
  "message": "Registration started. Enter the verification code sent to your email to activate your account."
}
```

**Errors:** 400 invalid input or password too weak · 409 email already registered and verified · 429 too many attempts

---

### Confirm Registration
**POST** `/auth/confirm`

Verify the email address with the code from the registration email.

**Request:**
```json
{
  "email": "john@example.com",
  "code": "123456"
}
```

**Response (200):**
```json
{
  "email": "john@example.com",
  "emailVerified": true,
  "message": "Email verified. You can now log in."
}
```

**Errors:** 400 wrong or expired code · 409 account already confirmed · 429 too many attempts

---

### Resend Verification Code
**POST** `/auth/resend-code`

Email a new code for a registration that hasn't been confirmed yet. Always returns the same response whether or not the address is registered.

**Request:**
```json
{
  "email": "john@example.com"
}
```

**Response (200):**
```json
{
  "message": "If that account is awaiting verification, a new code has been sent."
}
```

**Errors:** 400 invalid email · 429 too many attempts

---

### Login
**POST** `/auth/login`

Authenticate and get access tokens.

**Request:**
```json
{
  "email": "john@example.com",
  "password": "SecurePass123"
}
```

**Response (200):**
```json
{
  "accessToken": "eyJhbGc...",
  "idToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "expiresIn": 3600,
  "user": {
    "userId": "123e4567-e89b-12d3-a456-426614174000",
    "email": "john@example.com",
    "name": "John Smith",
    "role": "tradie"
  }
}
```

**Errors:** 401 wrong email or password · 403 email not verified:
```json
{
  "error": "Email address not verified. Enter the code sent to your email, or request a new one.",
  "code": "EMAIL_NOT_VERIFIED"
}
```

### Verification email delivery

By default Cognito sends the codes itself, which is limited to **50 emails per day** for the whole user pool. For production, send through Amazon SES by setting CDK context when deploying:

```bash
npx cdk deploy -c sesFromEmail=no-reply@homelink.com.au -c sesFromName=HomeLink
```

| Context key | Required | Meaning |
|---|---|---|
| `sesFromEmail` | yes (enables SES) | From address; must be a verified SES identity in ap-southeast-2 |
| `sesFromName` | no | Display name, e.g. `HomeLink` |
| `sesReplyTo` | no | Reply-to address |
| `sesVerifiedDomain` | no | Verified SES domain, if `sesFromEmail` is verified through its domain rather than individually |
| `sesConfigurationSet` | no | SES configuration set for delivery/bounce tracking |

The SES account must be out of the SES sandbox to email unverified recipients. Context keys can also go in `cdk.json` under `"context"`.

---

### Get Current User 🔒
**GET** `/auth/me`

Get authenticated user profile.

**Response (200):**
```json
{
  "userId": "123e4567-e89b-12d3-a456-426614174000",
  "email": "john@example.com",
  "name": "John Smith",
  "role": "tradie",
  "location": "Sydney",
  "hourlyRate": 75.00,
  "trade": "Plumber",
  "yearsExperience": 5,
  "bio": "Experienced plumber with 5 years",
  "createdAt": 1691000000,
  "updatedAt": 1691000000
}
```

---

### Logout 🔒
**POST** `/auth/logout`

Logout current user.

**Response (200):**
```json
{
  "message": "Logged out successfully"
}
```

---

## Profile Endpoints

### Get Tradie Profile
**GET** `/profiles/tradie/{tradieId}`

Get tradie profile with reviews and stats.

**Response (200):**
```json
{
  "tradieId": "123e4567-e89b-12d3-a456-426614174000",
  "name": "John Smith",
  "email": "john@example.com",
  "hourlyRate": 75.00,
  "location": "Sydney",
  "trade": "Plumber",
  "yearsExperience": 5,
  "bio": "Experienced plumber",
  "serviceTypes": ["Leaks", "Installation", "Repairs"],
  "photoGallery": ["url1", "url2"],
  "rating": 4.8,
  "reviewCount": 25,
  "reviews": [
    {
      "reviewId": "...",
      "rating": 5,
      "comment": "Great service!",
      "createdAt": 1691000000
    }
  ]
}
```

---

### Get Homeowner Profile
**GET** `/profiles/homeowner/{homeownerId}`

Get homeowner profile.

**Response (200):**
```json
{
  "homeownerId": "...",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "location": "Sydney",
  "createdAt": 1691000000
}
```

---

### Update Own Profile 🔒
**PATCH** `/profiles/me`

Update current user's profile.

**Request:**
```json
{
  "name": "John Smith Updated",
  "bio": "Senior plumber with 10 years experience",
  "hourlyRate": 85.00,
  "serviceTypes": ["Leaks", "Installation", "Repairs", "Maintenance"]
}
```

**Response (200):**
```json
{
  "userId": "...",
  "name": "John Smith Updated",
  "bio": "Senior plumber with 10 years experience",
  "hourlyRate": 85.00,
  "updatedAt": 1691001000
}
```

---

### Register as Tradie 🔒
**POST** `/profiles/tradie`

Complete tradie profile during onboarding.

**Request:**
```json
{
  "trade": "Electrician",
  "yearsExperience": 8,
  "serviceTypes": ["Installations", "Repairs", "Inspections"],
  "hourlyRate": 90.00,
  "bio": "Licensed electrician"
}
```

**Response (201):**
```json
{
  "tradieId": "...",
  "trade": "Electrician",
  "yearsExperience": 8,
  "hourlyRate": 90.00,
  "createdAt": 1691000000
}
```

---

## Availability Endpoints

### Get Available Hours
**GET** `/availability/tradie/{tradieId}?date={YYYY-MM-DD}`

Get hourly availability for a specific date.

**Response (200):**
```json
{
  "tradieId": "...",
  "date": "2024-08-20",
  "slots": [
    { "hour": 9, "available": true, "reason": "available" },
    { "hour": 10, "available": false, "reason": "booked" },
    { "hour": 11, "available": false, "reason": "booked" },
    { "hour": 12, "available": true, "reason": "available" },
    ...
  ],
  "workingHours": {
    "Monday": { "start": "09:00", "end": "17:00" },
    ...
  }
}
```

---

### Get Availability Range
**GET** `/availability/tradie/{tradieId}?from={date}&to={date}`

Get availability across multiple days.

**Response (200):**
```json
{
  "tradieId": "...",
  "fromDate": "2024-08-20",
  "toDate": "2024-08-25",
  "availabilityByDate": {
    "2024-08-20": { "availableCount": 6, "hours": [9, 12, 13, 14, 15, 16] },
    "2024-08-21": { "availableCount": 4, "hours": [14, 15, 16, 17] },
    ...
  }
}
```

---

### Check Slot Availability
**POST** `/availability/check`

Check if a specific time slot is available.

**Request:**
```json
{
  "tradieId": "...",
  "date": "2024-08-20",
  "startTime": "10:00",
  "endTime": "12:00"
}
```

**Response (200):**
```json
{
  "tradieId": "...",
  "date": "2024-08-20",
  "startTime": "10:00",
  "endTime": "12:00",
  "available": false,
  "reason": "booked"
}
```

---

## Booking Endpoints

### Create Booking 🔒
**POST** `/bookings`

Create a new booking (homeowner).

**Request:**
```json
{
  "tradieId": "123e4567-e89b-12d3-a456-426614174000",
  "date": "2024-08-20",
  "startTime": "10:00",
  "endTime": "12:00",
  "jobType": "Plumbing",
  "description": "Fix leaking kitchen tap"
}
```

**Response (201):**
```json
{
  "bookingId": "789f0123-e89b-12d3-a456-426614174000",
  "tradieId": "...",
  "homeownerId": "...",
  "date": "2024-08-20",
  "startTime": "10:00",
  "endTime": "12:00",
  "jobType": "Plumbing",
  "description": "Fix leaking kitchen tap",
  "status": "pending",
  "createdAt": 1691000000
}
```

---

### Get User's Bookings 🔒
**GET** `/bookings?user_id={id}&role={homeowner|tradie}`

Get all bookings for current user.

**Response (200):**
```json
{
  "userId": "...",
  "role": "tradie",
  "bookings": [
    {
      "bookingId": "...",
      "tradieId": "...",
      "homeownerId": "...",
      "date": "2024-08-20",
      "status": "accepted",
      "createdAt": 1691000000
    }
  ],
  "count": 5
}
```

---

### Get Booking Details
**GET** `/bookings/{bookingId}`

Get specific booking information.

**Response (200):**
```json
{
  "bookingId": "...",
  "tradieId": "...",
  "homeownerId": "...",
  "date": "2024-08-20",
  "startTime": "10:00",
  "endTime": "12:00",
  "jobType": "Plumbing",
  "description": "Fix leaking kitchen tap",
  "status": "accepted",
  "createdAt": 1691000000,
  "updatedAt": 1691001000
}
```

---

### Update Booking 🔒
**PATCH** `/bookings/{bookingId}`

Each request does one of three things: change the status, send a live arrival update, or reschedule. Mixing them in one request returns 400. The response is the updated booking.

#### Status change
```json
{
  "status": "accepted",
  "notes": "I can do this on that date"
}
```
Only the tradie can accept, decline or complete; only the homeowner can cancel (not once paid). Completing, cancelling or declining also stops location sharing and removes the live location.

#### Live arrival tracking (tradie, accepted bookings only)
```json
{
  "arrivalStatus": "en-route",
  "etaMinutes": 25,
  "liveLocation": { "latitude": -33.8688, "longitude": 151.2093, "accuracy": 15 }
}
```
All fields are optional, but at least one arrival field must be sent.

| Field | Rules |
|---|---|
| `arrivalStatus` | `en-route` (also accepts `on_the_way`, stored as `en-route`) or `arrived`. Arriving removes `etaMinutes` |
| `etaMinutes` | Number 0–1440; only while en route |
| `liveLocation` | `latitude` −90…90, `longitude` −180…180, optional `accuracy` in metres (0–100000). Other fields are dropped |
| `stopLocationSharing` | `true` stops sharing and removes the location. Allowed at any status, so the app can always withdraw it. Can't be combined with `liveLocation` |

Stored on the booking: `arrivalStatus`, `arrivalUpdatedAt`, `etaMinutes`, `locationSharing`, `liveLocation`, `locationUpdatedAt` (ISO 8601). Only the booking's homeowner and tradie can read them (`GET /bookings/{bookingId}`, `GET /bookings`). The homeowner gets a notification when the tradie sets off (`tradie-en-route`) and arrives (`tradie-arrived`), not on every ETA or location update.

Errors: 403 if the caller isn't the booking's tradie, 409 if the booking isn't accepted (or changed during the update), 400 for invalid values.

#### Reschedule (homeowner or tradie, pending or accepted bookings)
```json
{
  "date": "2024-08-22",
  "startTime": "13:00",
  "endTime": "15:00"
}
```
Any field left out keeps its current value. The same rules as creating a booking apply: valid date and times, start before end, not in the past, and the slot must be free in the tradie's working hours, days off and travel buffer (the booking itself is ignored). The other party gets a `booking-rescheduled` notification. The status doesn't change.

A paid booking can be rescheduled only if the new time costs exactly what was paid (the charge is the tradie's hourly rate times the duration). Otherwise it returns 409; keep the same duration, or refund and rebook.

Stored: `previousSchedule` (`{ date, startTime, endTime }`), `rescheduledAt`, `rescheduledBy`. Arrival details and the live location are cleared.

Errors: 409 if the slot isn't available, the booking isn't pending or accepted, the paid price would change, or the booking changed during the update.

---

## Review Endpoints

### Create Review 🔒
**POST** `/reviews`

Leave a review for completed booking (homeowner only).

**Request:**
```json
{
  "bookingId": "...",
  "rating": 5,
  "comment": "Excellent work, very professional!"
}
```

**Response (201):**
```json
{
  "reviewId": "...",
  "bookingId": "...",
  "tradieId": "...",
  "homeownerId": "...",
  "rating": 5,
  "comment": "Excellent work, very professional!",
  "createdAt": 1691000000
}
```

---

### Get Tradie Reviews
**GET** `/reviews/tradie/{tradieId}`

Get all reviews for a tradie.

**Response (200):**
```json
{
  "tradieId": "...",
  "reviews": [
    {
      "reviewId": "...",
      "rating": 5,
      "comment": "Great service!"
    }
  ],
  "averageRating": 4.8,
  "reviewCount": 25,
  "ratingDistribution": {
    "5": 20,
    "4": 3,
    "3": 2,
    "2": 0,
    "1": 0
  }
}
```

---

### Get Booking Review
**GET** `/reviews?booking_id={bookingId}`

Get review for specific booking (if exists).

**Response (200):**
```json
{
  "review": {
    "reviewId": "...",
    "rating": 5,
    "comment": "Great service!"
  }
}
```

---

## Message Endpoints

### Get Message Thread 🔒
**GET** `/messages/booking/{bookingId}`

Get all messages for a booking.

**Response (200):**
```json
{
  "bookingId": "...",
  "messages": [
    {
      "messageId": "...",
      "userId": "...",
      "senderRole": "tradie",
      "message": "I can do this job",
      "createdAt": 1691000000
    }
  ],
  "count": 3
}
```

---

### Send Message 🔒
**POST** `/messages/booking/{bookingId}`

Send message in booking thread.

**Request:**
```json
{
  "message": "Sounds good, I'll be there at 10am"
}
```

**Response (201):**
```json
{
  "messageId": "...",
  "bookingId": "...",
  "userId": "...",
  "senderRole": "homeowner",
  "message": "Sounds good, I'll be there at 10am",
  "createdAt": 1691000000
}
```

---

### Get Conversations 🔒
**GET** `/messages?user_id={id}`

Get list of conversations (one per booking).

**Response (200):**
```json
{
  "userId": "...",
  "conversations": [
    {
      "bookingId": "...",
      "tradieId": "...",
      "homeownerId": "...",
      "status": "accepted",
      "date": "2024-08-20",
      "lastMessage": "See you then!",
      "lastMessageAt": 1691000000
    }
  ],
  "count": 5
}
```

---

## Pricing Endpoints

### Calculate Pricing
**POST** `/pricing/calculate`

Calculate pricing breakdown.

**Request:**
```json
{
  "hourlyRate": 75.00,
  "hours": 2,
  "hasHomeinkPro": false
}
```

**Response (200):**
```json
{
  "hourlyRate": 75.00,
  "hours": 2,
  "subtotal": 150.00,
  "tradieCommissionPercent": 10,
  "tradieCommission": 15.00,
  "tradieEarns": 135.00,
  "homeownerFeePercent": 5,
  "homeownerFee": 7.50,
  "homeownerPays": 157.50,
  "hasPro": false
}
```

---

### Price Estimate
**POST** `/pricing/estimate` (public)

Price guide for a job, from what tradies in the trade charge.

**Request:**
```json
{
  "trade": "Plumbing",
  "location": "Parramatta",
  "description": "Replace a leaking kitchen tap",
  "durationHours": 2
}
```
`trade` is required (at most 100 characters); `durationHours` is a number from 0.5 to 24. `location` (at most 100 characters) and `description` (at most 2000) are optional.

**Response (200):**
```json
{
  "currency": "AUD",
  "low": 150,
  "high": 420,
  "hours": { "low": 1.5, "high": 3 },
  "sampleSize": 5,
  "source": "marketplace",
  "includesServiceFee": false,
  "disclaimer": "Guide only. The tradie confirms the final scope and price before work starts."
}
```
- Rates come from verified tradies in the trade (Users table `TradeRateIndex`), ignoring rates outside $30–$400/h. If 3 or more are in `location`, only those are used.
- `low` is the 25th percentile rate over 75% of the hours; `high` is the 75th percentile rate over 150% of the hours, both rounded to $5. With one rate, ±15% of it is used.
- With no data, `source` is `baseline` and a typical Sydney rate for the trade is used.
- HomeLink's service fee and card fee are not included.

---

### Get Booking Pricing
**GET** `/pricing/breakdown/{bookingId}`

Get pricing breakdown for specific booking.

**Response (200):**
```json
{
  "bookingId": "...",
  "tradieId": "...",
  "tradieHourlyRate": 75.00,
  "duration": { "hours": 2, "minutes": 120 },
  "subtotal": 150.00,
  "tradieCommissionPercent": 10,
  "tradieCommission": 15.00,
  "tradieEarns": 135.00,
  "homeownerFeePercent": 5,
  "homeownerFee": 7.50,
  "homeownerPays": 157.50
}
```

---

## Schedule Endpoints

### Get Tradie Schedule
**GET** `/schedule/tradie/{tradieId}`

Get tradie's working hours and days off.

**Response (200):**
```json
{
  "tradieId": "...",
  "workingHours": {
    "Monday": { "start": "09:00", "end": "17:00" },
    "Tuesday": { "start": "09:00", "end": "17:00" },
    "Wednesday": { "start": "09:00", "end": "17:00" },
    "Thursday": { "start": "09:00", "end": "17:00" },
    "Friday": { "start": "09:00", "end": "17:00" },
    "Saturday": { "off": true },
    "Sunday": { "off": true }
  },
  "unavailableDates": ["2024-08-20", "2024-08-27"],
  "travelBuffer": 30
}
```

---

### Update Working Hours 🔒
**PATCH** `/schedule/me`

Update own working hours.

**Request:**
```json
{
  "workingHours": {
    "Monday": { "start": "08:00", "end": "18:00" },
    "Tuesday": { "start": "08:00", "end": "18:00" },
    "Wednesday": { "off": true },
    "Thursday": { "start": "08:00", "end": "18:00" },
    "Friday": { "start": "08:00", "end": "18:00" },
    "Saturday": { "start": "09:00", "end": "14:00" },
    "Sunday": { "off": true }
  },
  "travelBuffer": 45
}
```

**Response (200):**
```json
{
  "tradieId": "...",
  "workingHours": { ... },
  "travelBuffer": 45,
  "message": "Schedule updated"
}
```

---

### Mark Day Unavailable 🔒
**POST** `/schedule/me/unavailable`

Mark a day as unavailable.

**Request:**
```json
{
  "date": "2024-08-20"
}
```

**Response (201):**
```json
{
  "tradieId": "...",
  "date": "2024-08-20",
  "message": "Day marked as unavailable"
}
```

---

### Remove Day Off 🔒
**DELETE** `/schedule/me/unavailable/{date}`

Remove unavailable day.

**Response (200):**
```json
{
  "tradieId": "...",
  "date": "2024-08-20",
  "message": "Unavailable day removed"
}
```

---

## Search Endpoints

### Search Tradies
**GET** `/search?trade={type}&location={suburb}&rating_min={floor}`

Search for tradies with filters.

**Response (200):**
```json
{
  "filters": {
    "trade": "Plumber",
    "location": "Sydney",
    "ratingMin": 4.5
  },
  "tradies": [
    {
      "tradieId": "...",
      "name": "John Smith",
      "location": "Sydney",
      "hourlyRate": 75.00,
      "trade": "Plumber",
      "rating": 4.8,
      "reviewCount": 25
    }
  ],
  "count": 5
}
```

---

### Get Available Trades
**GET** `/trades`

Get list of available trade types.

**Response (200):**
```json
{
  "trades": ["Electrician", "Plumber", "Carpenter", "Painter"],
  "count": 4
}
```

---

### Get Available Locations
**GET** `/locations`

Get list of available work locations.

**Response (200):**
```json
{
  "locations": ["Bondi", "Parramatta", "Sydney CBD", "Wollongong"],
  "count": 4
}
```

---

## Notification Endpoints

### Get Notifications 🔒
**GET** `/notifications?user_id={id}`

Get current notifications.

**Response (200):**
```json
{
  "userId": "...",
  "notifications": [
    {
      "userId": "...",
      "notificationId": "...",
      "message": "New booking request from homeowner",
      "type": "booking-request",
      "relatedId": "...",
      "read": false,
      "createdAt": 1691000000
    }
  ],
  "totalCount": 5,
  "unreadCount": 3
}
```

---

### Mark Notification as Read 🔒
**PATCH** `/notifications/{notificationId}`

Mark specific notification as read.

**Response (200):**
```json
{
  "notificationId": "...",
  "read": true,
  "updatedAt": 1691001000
}
```

---

### Delete Notification 🔒
**DELETE** `/notifications/{notificationId}`

Delete a notification.

**Response (200):**
```json
{
  "message": "Notification deleted"
}
```

---

### Mark All as Read 🔒
**PATCH** `/notifications/read-all`

Mark all notifications as read.

**Response (200):**
```json
{
  "message": "All notifications marked as read",
  "count": 3
}
```

---

## Error Responses

All errors return standard format:

```json
{
  "error": "Error message"
}
```

### Common Status Codes
- **200** - Success
- **201** - Created
- **400** - Bad request
- **401** - Unauthorized
- **403** - Forbidden
- **404** - Not found
- **409** - Conflict (e.g., slot already booked)
- **500** - Server error

---

## Rate Limiting

API Gateway default limits apply:
- 10,000 requests per second
- 5,000 burst capacity

---

## CORS

Allowed origins come from the CDK context: `allowedOrigins` (comma-separated or a list) plus `frontendUrl`. With neither set, any origin is allowed (`*`).

```bash
npx cdk deploy \
  --context frontendUrl=https://app.homelink.com.au \
  --context allowedOrigins=capacitor://localhost,https://localhost,https://staging.xxxx.amplifyapp.com
```

`capacitor://localhost` (iOS) and `https://localhost` (Android) are the Capacitor app origins. Preflight (`OPTIONS`) and Lambda responses return the caller's `Origin` in `Access-Control-Allow-Origin` when it's allowed, with `Vary: Origin`; other origins get no `Access-Control-Allow-Origin`.

```
Access-Control-Allow-Methods: OPTIONS, GET, PUT, POST, DELETE, PATCH, HEAD
Access-Control-Allow-Headers: Content-Type, Authorization
```
