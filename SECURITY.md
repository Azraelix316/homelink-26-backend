# Security review: auth, Stripe webhooks, IAM

Reviewed on 19 Oct 2026 against `feat/frontend-parity`. Nothing critical is open. The safe fixes below are in place and covered by `test/security-hardening.test.js`. The remaining items need a decision or money, so they are listed for you rather than changed.

## What was checked

| Area | Result |
| --- | --- |
| Identity | Handlers use the immutable `custom:userId` claim from the Cognito-verified ID token. Users can only edit their `name`, so they can't change their role or ID |
| Sign-up | A PreSignUp trigger rejects sign-ups that skip `POST /auth/register`. Only the backend's secret-holding client can set the role and user ID. Users are never auto-confirmed |
| Login | Wrong email and wrong password give the same 401, so accounts can't be enumerated. Unverified users get 403 with `EMAIL_NOT_VERIFIED`. Cognito's own lockout applies after repeated failures |
| Authorization | Every route except sign-in, sign-up, public browsing and the Stripe webhook needs a Cognito token. Booking, payment and pricing reads check that the caller is the booking's homeowner or tradie |
| Stripe webhook | Verified with `stripe.webhooks.constructEvent` against the raw body (base64 decoded when needed), Stripe's 5-minute timestamp tolerance, and both the platform and Connect signing secrets. Forged or unsigned requests get 400 and touch nothing |
| Webhook effects | Handlers are idempotent: one payment record and one notification per intent. They only act on the booking's current intent, the user's own Connect account and the user's own Stripe customer, and older events never overwrite newer ones. Processing errors return 500 so Stripe retries |
| Amounts | Charges are calculated on the server from the tradie's rate. Client-sent amounts are ignored |
| Secrets | Stripe keys live in Secrets Manager, never in Lambda environment variables or code. Only the Lambdas that call Stripe can read them |
| IAM | No inline policy uses `Resource: "*"`. Cognito admin actions are listed per function and scoped to the user pool. Table access is per function (read, write or both) |
| CORS | Limited to the configured origins (frontend URL and the Capacitor apps) |
| Input | Dates, times, rates, ratings, coordinates, text lengths and page sizes are validated. Unknown fields are dropped |

## Fixed in this review

1. **Logout now revokes the user's sessions** (`AdminUserGlobalSignOut`), so a stolen refresh token can't mint new tokens. Before, logout only told the client to forget its tokens.
2. **Per-route throttles** on routes that are cheap to abuse:

   | Route | Limit (requests/second, burst) |
   | --- | --- |
   | `POST /auth/register` | 5, 10 |
   | `POST /auth/resend-code` | 2, 5 |
   | `POST /auth/confirm` | 5, 10 |
   | `POST /auth/login` | 10, 20 |
   | `GET /search`, `/trades`, `/locations` | 20, 40 |

   The first three send email, so the limits stop the API being used to flood someone's inbox. Login limits password guessing. The search routes read whole tables. Everything else keeps the stage limit of 100/200.
3. **Response headers:** every response now sends `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, so per-user JSON is never cached by a browser or proxy.
4. **Least privilege:** `GET /payments/pro/status` lost its unused access to the Stripe secret and its write access to the Users table.

## Open items

| # | Item | Risk | Suggested fix | Needs |
| --- | --- | --- | --- | --- |
| 1 | Tables and the user pool have `DeletionPolicy: Delete` | A `cdk destroy` or a resource rename deletes all users and bookings | `removalPolicy: RETAIN` before launch | Your decision (see DEPLOY_PLAN.md) |
| 2 | Throttles apply to everyone at once, not per IP | One abuser can use up a route's limit and lock out real users | AWS WAF with a per-IP rate rule on `/auth/*` (about US$5/month + US$1/rule + US$0.60 per million requests) | Budget decision |
| 3 | ID tokens can't be revoked | A stolen ID token works until it expires, up to 1 hour, even after logout | Shorter ID token lifetime (e.g. 15 min) plus refresh in the frontend. The frontend has no refresh flow today, so sessions also simply end after an hour | Frontend work |
| 4 | Tokens are stored in `localStorage` | Any XSS bug in the frontend could read them | Content-Security-Policy and other security headers on the Amplify site (`customHttp.yml`) | Frontend hosting change |
| 5 | Unused Cognito identity pool and role | No permissions today, so harmless, but it is attack surface nobody uses | Remove both from `lib/cognito.js` | Confirm nothing uses it |
| 6 | No access logs or alarms | Abuse or webhook failures would go unnoticed | API Gateway access logging, alarms on 5xx and webhook errors, log retention | Small CloudWatch cost |
| 7 | PreSignUp doesn't check which client called it | Defence in depth only: the attribute rules already block direct sign-ups | Check `callerContext.clientId` against the registration client (needs care to avoid a circular reference in CDK) | — |
| 8 | No Cognito threat protection or MFA | Leaked passwords from other sites can be used here | Cognito Plus plan threat protection, optional TOTP MFA for tradies | Cost (Plus is US$0.02 per monthly active user) |
| 9 | Search reads whole tables | Each public search costs up to about 256 read units. Now throttled, but still wasteful, and results are cut off past ~1 MB of users | Query the existing Trade and Location indexes instead | Code change |
| 10 | No refunds | Paid bookings can't be cancelled (by design for now), so disputes go through Stripe manually | Refund endpoint with `reverse_transfer` and `refund_application_fee` | Product decision |

## Reporting

Send security issues to the repository owner privately rather than opening a public issue.
