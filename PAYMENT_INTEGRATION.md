# Stripe Payment Integration for HomeLink

## Overview
Homeowners pay for accepted bookings with Stripe. Payments use **Stripe Connect destination charges**: the homeowner is charged the full price, the tradie's Connect account receives their share, and Stripe automatically routes HomeLink's cut to the platform as an application fee.

| On a A$225 job (2.5 h × A$90) | Standard tradie | HomeLink Pro tradie |
| --- | --- | --- |
| Homeowner service fee (5%) | 11.25 | 11.25 |
| Card processing markup | 4.27 | 4.27 |
| **Homeowner pays** | **240.52** | **240.52** |
| Tradie commission (10%) | 22.50 | 0.00 |
| **Tradie receives** | **202.50** | **225.00** |
| HomeLink application fee | 38.02 | 15.52 |
| Stripe card fee (1.65% + A$0.30, paid from the application fee) | −4.27 | −4.27 |
| **HomeLink keeps** | **33.75** | **11.25** |

The card processing markup grosses the price up so Stripe's card fee is covered by the homeowner: `homeownerPays = (subtotal + serviceFee + A$0.30) / (1 − 1.65%)`, rounded up to the cent. The rates are set with the `stripeFeePercent` and `stripeFeeFixed` CDK context keys. International cards (3.5% + A$0.30) still cost more than the markup covers. Connect payout fees are not marked up.

The amount is always calculated by the backend from the tradie's `hourlyRate` and the booking duration. Clients never send an amount.

## Setup Requirements

### 1. Stripe secret
Stripe keys are read from AWS Secrets Manager, not Lambda environment variables. Create a secret named `homelink/stripe` (or pass `--context stripeSecretName=...`) in the same region as the stack:

```json
{
  "secretKey": "sk_test_...",
  "webhookSecret": "whsec_...",
  "connectWebhookSecret": "whsec_..."
}
```

```bash
aws secretsmanager create-secret --region ap-southeast-2 --name homelink/stripe \
  --secret-string '{"secretKey":"sk_test_...","webhookSecret":"whsec_...","connectWebhookSecret":"whsec_..."}'
```

`connectWebhookSecret` is only needed if you use a separate Connect webhook endpoint (see below).

### 2. CDK context
| Context key | Default | Purpose |
|---|---|---|
| `stripeSecretName` | `homelink/stripe` | Secrets Manager secret holding the keys |
| `stripeCurrency` | `aud` | Currency for all charges |
| `frontendUrl` | `http://localhost:3000` | Base URL for Connect and Pro return links; also an allowed CORS origin (add more with `allowedOrigins`, see API_REFERENCE.md) |
| `stripeFeePercent` | `0.0165` | Card fee percentage passed on to homeowners |
| `stripeFeeFixed` | `0.30` | Fixed card fee (in `stripeCurrency`) passed on to homeowners |
| `proMonthlyPriceId` | none | Stripe Price ID for monthly Pro. If unset, an inline price is used |
| `proAnnualPriceId` | none | Stripe Price ID for annual Pro. If unset, an inline price is used |
| `proCurrency` | `aud` | Currency of the inline Pro prices |
| `proMonthlyPriceCents` | `14900` | Inline monthly Pro price, in cents (A$149) |
| `proAnnualPriceCents` | `149000` | Inline annual Pro price, in cents (A$1,490) |

```bash
CDK_DEFAULT_REGION=ap-southeast-2 npx cdk deploy --context frontendUrl=https://app.homelink.com.au
```

### 3. Stripe dashboard
1. Enable **Connect** (Express accounts, Australia).
2. Add a webhook endpoint at `https://{API_ENDPOINT}/prod/payments/webhook` for **events on your account**:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Add a webhook endpoint at the same URL for **events on connected accounts**:
   - `account.updated`
4. Put both signing secrets in the Secrets Manager secret.
5. Configure the **Customer portal** (Settings → Billing → Customer portal) so Pro tradies can update their card and cancel.
6. Optional: create a HomeLink Pro product with an A$149/month and an A$1,490/year Price, and pass their IDs as `proMonthlyPriceId` and `proAnnualPriceId`. Tradies can then switch between monthly and annual in the Customer portal. Inline prices work for checkout but can't be offered as portal switches.

## Payment Flow

```
1. Tradie: POST /payments/connect/onboard  -> completes Stripe onboarding
2. Homeowner books, tradie accepts          -> booking.status = accepted
3. Homeowner: POST /payments/create-payment-intent  -> paymentStatus = payment_pending
4. Frontend confirms the card with Stripe.js
5. Webhook payment_intent.succeeded and/or POST /payments/confirm-payment
                                            -> paymentStatus = paid, payment record written,
                                               tradie notified (once)
```

Both step 5 paths are idempotent, so it's safe for both to run. The webhook is the source of truth; `confirm-payment` lets the frontend get an immediate answer.

## Payment Endpoints

### 1. Create Payment Intent
**POST** `/payments/create-payment-intent` (Cognito auth, homeowner on the booking)

```json
{ "bookingId": "uuid" }
```

**Response (200)**
```json
{
  "clientSecret": "pi_xxx_secret_yyy",
  "paymentIntentId": "pi_xxx",
  "amount": 213.83,
  "currency": "aud",
  "status": "requires_payment_method"
}
```

Calling it again for the same booking returns the same PaymentIntent while it's still payable and the price hasn't changed. If the price changed, the old intent is cancelled and a new one is created.

**Errors**
- `400` - Missing `bookingId`, or booking is not `accepted`/`completed`
- `403` - Caller is not the homeowner on the booking
- `404` - Booking or tradie not found
- `409` - Booking already paid or processing, or the tradie hasn't finished payout setup

### 2. Confirm Payment
**POST** `/payments/confirm-payment` (Cognito auth, homeowner on the booking)

```json
{ "bookingId": "uuid", "paymentIntentId": "pi_xxx" }
```

**Response (200)**
```json
{
  "paymentId": "uuid",
  "bookingId": "uuid",
  "status": "completed",
  "amount": 213.83,
  "currency": "AUD",
  "message": "Payment confirmed successfully"
}
```

**Errors**
- `400` - PaymentIntent isn't this booking's current intent, or hasn't succeeded
- `403` - Caller is not the homeowner on the booking
- `409` - PaymentIntent was replaced before it was recorded

### 3. Get Payment
**GET** `/payments/{paymentId}` (Cognito auth, homeowner or tradie on the booking)

```json
{
  "paymentId": "uuid",
  "bookingId": "uuid",
  "homeownerId": "uuid",
  "tradieId": "uuid",
  "stripePaymentIntentId": "pi_xxx",
  "amount": 213.83,
  "applicationFee": 33.83,
  "currency": "AUD",
  "status": "completed",
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

### 4. Get Booking Payment
**GET** `/payments/booking/{bookingId}` (Cognito auth, homeowner or tradie on the booking)

Returns the most recent payment record for the booking (same shape as above).

### 5. Start Payout Setup (tradies)
**POST** `/payments/connect/onboard` (Cognito auth, tradie)

Creates the tradie's Stripe Express account on first call and returns a one-time onboarding link. Call it again to get a fresh link if the old one expired.

```json
{
  "stripeAccountId": "acct_xxx",
  "onboardingUrl": "https://connect.stripe.com/setup/...",
  "expiresAt": 1234567890
}
```

Stripe redirects back to `{frontendUrl}/#/payouts/setup?complete=true` (or `?refresh=true` if the link expired). The frontend uses hash routing, so return links carry the route after `#`.

### 6. Payout Status (tradies)
**GET** `/payments/connect/status` (Cognito auth, tradie)

```json
{
  "onboarded": true,
  "chargesEnabled": true,
  "payoutsEnabled": true,
  "requirementsDue": []
}
```

This also refreshes the stored status, in case the `account.updated` webhook hasn't arrived yet.

### 7. Webhook Handler
**POST** `/payments/webhook` (no Cognito auth; verified with the Stripe signature)

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | Marks booking paid, writes payment record, notifies tradie (once) |
| `payment_intent.payment_failed` | `paymentStatus = payment_failed` (ignored if already paid or for a replaced intent) |
| `payment_intent.canceled` | `paymentStatus = payment_cancelled` (same rules) |
| `account.updated` | Updates the tradie's `stripeChargesEnabled` / `stripePayoutsEnabled` |
| `customer.subscription.*` | Turns HomeLink Pro on (`active`, `trialing`) or off (anything else); older events never overwrite newer ones |

Processing errors return `500` so Stripe retries the event.

## HomeLink Pro (tradies)
HomeLink Pro is a subscription (A$149 a month or A$1,490 a year by default) that removes the 10% tradie commission. Homeowners still pay the 5% service fee and card markup. The subscription is billed through Stripe Billing on the platform account, separate from the tradie's Connect payout account.

### Subscribe
**POST** `/payments/pro/subscribe` (Cognito auth, tradie)

```json
{ "billingCycle": "annual" }
```

`billingCycle` is `monthly` (default) or `annual`. Returns a Stripe Checkout URL. After payment, Stripe redirects to `{frontendUrl}/#/pro?status=success` (or `?status=cancelled`), and the `customer.subscription.created` webhook turns Pro on.

```json
{ "checkoutUrl": "https://checkout.stripe.com/...", "expiresAt": 1234567890, "billingCycle": "annual" }
```

`400` for an unknown `billingCycle`; `409` if the tradie already has Pro.

### Manage or cancel
**POST** `/payments/pro/portal` (Cognito auth, tradie)

```json
{ "portalUrl": "https://billing.stripe.com/..." }
```

### Status
**GET** `/payments/pro/status` (Cognito auth, tradie)

```json
{ "hasPro": true, "status": "active", "billingCycle": "annual", "currentPeriodEnd": 1234567890, "cancelAtPeriodEnd": false }
```

Pro takes effect on payments started after it turns on. An unpaid PaymentIntent created before is replaced with the new price the next time the homeowner opens checkout. If a renewal payment fails (`past_due`), Pro switches off until it's paid.

## Stored Fields

**Bookings table**
| Field | Type | Description |
|-------|------|-------------|
| `stripePaymentIntentId` | String | Current Stripe PaymentIntent for the booking |
| `paymentStatus` | String | `payment_pending`, `paid`, `payment_failed`, `payment_cancelled` |
| `paymentId` | String | Payments table record ID |
| `paymentAmount` | Number | Amount paid, in dollars |
| `paymentDate` | Number | Unix timestamp |

**Users table (tradies)**
| Field | Type | Description |
|-------|------|-------------|
| `stripeAccountId` | String | Stripe Connect Express account |
| `stripeChargesEnabled` | Boolean | Can accept payments; required before homeowners can pay |
| `stripePayoutsEnabled` | Boolean | Can receive payouts |
| `stripeCustomerId` | String | Stripe Customer billed for HomeLink Pro |
| `hasHomeinkPro` | Boolean | Pro is active; set only by the subscription webhook |
| `proStatus` | String | Stripe subscription status |
| `proSubscriptionId` | String | Stripe subscription ID |
| `proBillingCycle` | String | `monthly` or `annual` |
| `proCurrentPeriodEnd` | Number | Unix timestamp the current billing period ends |
| `proCancelAtPeriodEnd` | Boolean | Pro ends at the end of the current period |

## Frontend Integration

```javascript
import { loadStripe } from '@stripe/stripe-js';

const stripe = await loadStripe('pk_test_...');

// 1. Create (or reuse) the payment intent - the backend works out the amount
const { clientSecret, paymentIntentId } = await fetch('/payments/create-payment-intent', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ bookingId }),
}).then(r => r.json());

// 2. Confirm with Stripe (Payment Element or card element)
const { error } = await stripe.confirmPayment({ elements, clientSecret, redirect: 'if_required' });

// 3. Tell the backend
if (!error) {
  await fetch('/payments/confirm-payment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId, paymentIntentId }),
  });
}
```

## Testing

### Unit tests
```bash
npm test
```

`test/payments.test.js` covers pricing, ownership checks, idempotency and webhook handling with Stripe and DynamoDB mocked.

### Test cards (Stripe)
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`
- Requires authentication: `4000 0025 0000 3155`

### Webhooks with the Stripe CLI
```bash
stripe listen --forward-to https://{API_ENDPOINT}/prod/payments/webhook
stripe trigger payment_intent.succeeded
```

## Production Considerations
1. Use live keys (`sk_live_...`) in a separate secret for production.
2. The price is calculated from the tradie's current `hourlyRate` when payment starts. If you need the price fixed when the booking is accepted, store it on the booking at that point.
3. A paid booking can be rescheduled (`PATCH /bookings/{bookingId}`) only if the new time costs exactly `paymentAmount` at the tradie's current rate, so a reschedule never changes what was charged. A booking with an unpaid PaymentIntent can be rescheduled freely; the intent is re-priced the next time the homeowner opens checkout.
4. Refunds and disputes are not handled yet. Destination-charge refunds need `reverse_transfer` and `refund_application_fee` decisions.
5. Monitor failed payments and webhook errors in CloudWatch.
