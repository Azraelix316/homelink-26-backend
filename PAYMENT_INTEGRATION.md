# Stripe Payment Integration for HomeLink

## Overview
Stripe payment processing has been integrated for homeowners to pay for tradie services. All payments are securely processed through Stripe's PaymentIntent API.

## Setup Requirements

### 1. Stripe Configuration
You need to set the following environment variables on the Lambda functions:

```
STRIPE_SECRET_KEY=sk_test_... (or sk_live_... for production)
STRIPE_WEBHOOK_SECRET=whsec_... (webhook endpoint secret)
```

**To get these keys:**
1. Go to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Navigate to **Developers > API Keys**
3. Copy the Secret Key
4. Go to **Developers > Webhooks**
5. Create webhook endpoint pointing to: `https://{API_ENDPOINT}/prod/payments/webhook`
6. Subscribe to events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`
7. Copy the webhook signing secret

### 2. DynamoDB Tables
- **Payments Table**: New table created to store payment records
- **Bookings Table**: Updated with `paymentStatus`, `stripePaymentIntentId`, and `paymentAmount` fields

## Payment Endpoints

### 1. Create Payment Intent
**POST** `/payments/create-payment-intent`

**Authentication**: Required (authenticated homeowner)

**Request Body:**
```json
{
  "bookingId": "booking-123",
  "amount": 250.50,
  "currency": "AUD"
}
```

**Response:**
```json
{
  "clientSecret": "pi_1234567890_secret_abcdef",
  "paymentIntentId": "pi_1234567890",
  "amount": 250.50,
  "currency": "AUD",
  "status": "requires_payment_method"
}
```

**Error Scenarios:**
- `401` - Not authenticated
- `400` - Missing fields or booking not confirmed
- `403` - Not authorized (not the homeowner)
- `404` - Booking not found

---

### 2. Confirm Payment
**POST** `/payments/confirm-payment`

**Authentication**: Required (authenticated homeowner)

**Request Body:**
```json
{
  "bookingId": "booking-123",
  "paymentIntentId": "pi_1234567890"
}
```

**Response:**
```json
{
  "paymentId": "payment-456",
  "bookingId": "booking-123",
  "status": "completed",
  "amount": 250.50,
  "currency": "AUD",
  "message": "Payment confirmed successfully"
}
```

**Notes:**
- Only confirms payments that have already succeeded in Stripe
- Creates payment record in DynamoDB
- Notifies tradie of payment receipt

---

### 3. Get Payment
**GET** `/payments/{paymentId}`

**Authentication**: Optional

**Response:**
```json
{
  "paymentId": "payment-456",
  "bookingId": "booking-123",
  "homeownerId": "user-123",
  "stripePaymentIntentId": "pi_1234567890",
  "amount": 250.50,
  "currency": "AUD",
  "status": "completed",
  "createdAt": 1691052000,
  "updatedAt": 1691052000
}
```

---

### 4. Get Booking Payment
**GET** `/payments/booking/{bookingId}`

**Authentication**: Optional

**Response:**
```json
{
  "paymentId": "payment-456",
  "bookingId": "booking-123",
  "homeownerId": "user-123",
  "amount": 250.50,
  "currency": "AUD",
  "status": "completed",
  "createdAt": 1691052000
}
```

---

### 5. Webhook Handler
**POST** `/payments/webhook`

**Authentication**: None (Stripe webhook)

**Webhook Events Handled:**
- `payment_intent.succeeded` - Updates booking to `paid` status
- `payment_intent.payment_failed` - Updates booking to `payment_failed` status
- `payment_intent.canceled` - Updates booking to `payment_cancelled` status

**Security**: Webhook signature verified using `STRIPE_WEBHOOK_SECRET`

## Payment Status Flow

```
confirmed booking
    ↓
homeowner calls create-payment-intent
    ↓
receives clientSecret
    ↓
frontend uses clientSecret with Stripe.js to collect payment
    ↓
payment processed in Stripe
    ↓
homeowner calls confirm-payment
    ↓
Lambda verifies payment succeeded
    ↓
booking status → payment_pending → paid
tradie notified
```

## Booking Table Updates

The Bookings table now includes:

| Field | Type | Description |
|-------|------|-------------|
| `paymentStatus` | String | `payment_pending`, `paid`, `payment_failed`, `payment_cancelled` |
| `stripePaymentIntentId` | String | Stripe's PaymentIntent ID for tracking |
| `paymentAmount` | Number | Amount paid in booking currency |
| `paymentDate` | Number | Timestamp of payment completion |

## Frontend Integration

### Using Stripe.js

```javascript
import { loadStripe } from '@stripe/js';

const stripe = await loadStripe('pk_test_...');

// 1. Create payment intent
const response = await fetch('/payments/create-payment-intent', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    bookingId: 'booking-123',
    amount: 250.50,
    currency: 'AUD'
  })
});

const { clientSecret } = await response.json();

// 2. Use clientSecret with stripe.confirmPayment or confirmCardPayment
const result = await stripe.confirmPayment({
  elements,
  clientSecret,
  redirect: 'if_required'
});

if (result.error) {
  // Show error to user
  console.error(result.error.message);
} else {
  // 3. Confirm payment on backend
  await fetch('/payments/confirm-payment', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      bookingId: 'booking-123',
      paymentIntentId: result.paymentIntent.id
    })
  });
  
  // Payment successful!
}
```

## Lambda Permissions

The Payments Lambda has access to:
- **Bookings Table**: Read/Write (to store payment intent and update status)
- **Payments Table**: Write (to record payment)
- **Notifications Table**: Write (to notify tradie)

## Error Handling

### Payment Already Paid
```json
{
  "statusCode": 400,
  "body": { "error": "Can only pay for confirmed bookings" }
}
```

### Unauthorized User
```json
{
  "statusCode": 403,
  "body": { "error": "Not authorized to pay for this booking" }
}
```

### Stripe API Error
```json
{
  "statusCode": 500,
  "body": { "error": "Failed to create payment intent" }
}
```

## Testing

### Test Cards (Stripe)
- **Successful**: `4242 4242 4242 4242`
- **Declined**: `4000 0000 0000 0002`
- **3D Secure**: `4000 0025 0000 3155`
- **Expiry**: Any future date (e.g., 12/25)
- **CVC**: Any 3 digits (e.g., 123)

### Test with cURL

```bash
# Create payment intent
curl -X POST https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/payments/create-payment-intent \
  -H "Authorization: Bearer {idToken}" \
  -H "Content-Type: application/json" \
  -d '{
    "bookingId": "booking-123",
    "amount": 250.50,
    "currency": "AUD"
  }'

# Confirm payment (after Stripe payment succeeds)
curl -X POST https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/payments/confirm-payment \
  -H "Authorization: Bearer {idToken}" \
  -H "Content-Type: application/json" \
  -d '{
    "bookingId": "booking-123",
    "paymentIntentId": "pi_1234567890"
  }'

# Get payment
curl https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod/payments/payment-456
```

## Webhook Testing

Use Stripe CLI to test webhooks locally:

```bash
# Forward webhook events to your local endpoint
stripe listen --forward-to localhost:3000/payments/webhook

# Trigger a test event
stripe trigger payment_intent.succeeded
```

## Production Considerations

1. **Use Live Keys**: Replace test keys with live Stripe keys
2. **Webhook Verification**: Always verify webhook signatures
3. **Idempotency**: Use idempotency keys for payment operations
4. **Reconciliation**: Regularly reconcile Stripe payments with DynamoDB records
5. **Refunds**: Implement refund handling if needed
6. **PCI Compliance**: Use Stripe Hosted Checkout or embedded Elements (never store raw card data)
7. **Logging**: Log all payment transactions for audit trails

## Revenue Share

If you want to implement revenue sharing:
- Add `platformFee` calculation when creating PaymentIntent
- Use Stripe Connect for automatic fund transfers to tradies
- Store fee details in Payments table

```javascript
const platformFeePercent = 0.10; // 10%
const platformFee = Math.round(amount * platformFeePercent * 100); // In cents

const paymentIntent = await stripe.paymentIntents.create({
  amount: Math.round(amount * 100),
  currency,
  application_fee_amount: platformFee, // For Stripe Connect
  metadata: { bookingId, homeownerId }
});
```

## Support

For Stripe API documentation: https://stripe.com/docs/api
For Stripe.js documentation: https://stripe.com/docs/js
