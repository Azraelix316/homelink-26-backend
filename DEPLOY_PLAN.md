# Deploy plan: feat/frontend-parity

Deploying this branch updates the existing `HomeLinkBackendStack` in Sydney (ap-southeast-2) in place. An offline comparison with `main` found no database table or user pool that would be recreated. The live `cdk diff` below must confirm that before you deploy, because nobody has compared it with the stack that is actually running.

Status on 18 Oct 2026: not deployed. No AWS login was available on the machine that prepared this, so the live diff has not been run.

## What changes

| Resource | Change | Risk |
| --- | --- | --- |
| Cognito user pool | Self sign-up turned on (guarded by a new PreSignUp Lambda that only allows sign-ups from `POST /auth/register`), email auto-verification, new email text | In-place update. Existing users are kept |
| Cognito app client | Users can now only edit their `name` | In-place update |
| Cognito registration client | New client used by `/auth/register` | Added |
| Users table | New `TradeRateIndex` index (for `/pricing/estimate`) | In-place. CloudFormation allows one index change per table per deploy; this is the only one |
| Other 7 tables | No change | None |
| Lambdas | Node 18 → Node 22, new handlers (Connect, Pro, webhook, arrival, reschedule, estimate, confirm, resend) | Replaced in place, as normal |
| API Gateway | New routes, login required on more routes, CORS limited to your origins, throttled to 100 requests/second | Requests from origins not on the list are blocked |

Comparison method: `cdk synth` of `main` (6cd83b4) and `feat/frontend-parity` (f0b0446), comparing every DynamoDB table, user pool, app client and identity pool. Properties that force a replacement (table name, key schema, user pool username/alias attributes, attribute schema) are unchanged.

## Risks

1. **The deployed stack may not match `main`.** If someone deployed from another branch, the live diff can differ. Run step 4 and read it before deploying.
2. **Every table and the user pool are set to be deleted with the stack** (`DeletionPolicy: Delete`). A `cdk destroy`, a renamed resource or a failed first deploy would delete all data. Before real users arrive, switch them to `RETAIN` (see "Decisions").
3. **Payments fail until the Stripe secret exists.** The functions read `homelink/stripe` from Secrets Manager when they are called. If the secret is missing, payment, payout and Pro endpoints return 500. Everything else works.
4. **Cognito's built-in email sends at most 50 emails a day.** Verification codes and password resets stop after that. Set up SES (step 7) before launch.
5. **Old bookings may not match their homeowner.** Bookings created on the old backend stored the Cognito `sub` as `homeownerId`, while the new code uses `custom:userId`. User accounts are unaffected.
6. **Don't use `npm run cdk:deploy`.** It skips the approval prompt (`--require-approval=never`) and assumes an AWS profile named `homelink`. Use the commands below.

## Steps

### What you need to do (needs your credentials)

1. Log in to the AWS account that runs the current API (`wq95aewird.execute-api.ap-southeast-2.amazonaws.com`):
   ```bash
   aws login --region ap-southeast-2
   aws sts get-caller-identity
   ```
2. Create the Stripe secret with your **test** key. The webhook secrets come later:
   ```bash
   aws secretsmanager create-secret --region ap-southeast-2 --name homelink/stripe \
     --secret-string '{"secretKey":"sk_test_...","webhookSecret":"whsec_placeholder"}'
   ```

### Preview (read-only)

3. Install the Lambda dependencies. Each function bundles its own `aws-sdk` and `stripe`, and Node 22 doesn't include the AWS SDK v2:
   ```bash
   npm ci
   npm run install:lambdas
   ```
4. Diff against the live stack:
   ```bash
   CDK_DEFAULT_REGION=ap-southeast-2 npx cdk diff \
     --context frontendUrl=https://staging.d8ahda75tw3qj.amplifyapp.com \
     --context allowedOrigins=capacitor://localhost,https://localhost
   ```
   Stop if the output shows `[-]` or `replace` next to any `AWS::DynamoDB::Table` or `AWS::Cognito::UserPool`.
5. If the account has never used CDK in ap-southeast-2: `npx cdk bootstrap aws://<account-id>/ap-southeast-2`.

### Deploy

6. Same context as the diff. The prompt shows IAM changes for approval:
   ```bash
   CDK_DEFAULT_REGION=ap-southeast-2 npx cdk deploy \
     --context frontendUrl=https://staging.d8ahda75tw3qj.amplifyapp.com \
     --context allowedOrigins=capacitor://localhost,https://localhost
   ```
   Note the `ApiEndpoint` output. If it differs from the frontend's `VITE_API_BASE_URL`, update the frontend.

### After deploy

7. Optional before launch: verify a sending domain in SES, then redeploy with `--context sesFromEmail=no-reply@<domain> --context sesVerifiedDomain=<domain>`.
8. In the Stripe dashboard (test mode):
   - Turn on Connect (Express, Australia).
   - Add a webhook at `<ApiEndpoint>/payments/webhook` for account events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - Add a second webhook at the same URL for connected-account events: `account.updated`.
   - Configure the Customer portal.
   - Optional: create Pro prices (A$149/month, A$1,490/year) and redeploy with `proMonthlyPriceId` / `proAnnualPriceId` so tradies can switch plans in the portal.
9. Put the real webhook secrets in place:
   ```bash
   aws secretsmanager put-secret-value --region ap-southeast-2 --secret-id homelink/stripe \
     --secret-string '{"secretKey":"sk_test_...","webhookSecret":"whsec_...","connectWebhookSecret":"whsec_..."}'
   ```
10. Smoke test:
    - `GET /trades` returns 200.
    - `GET /bookings` without a token returns 401.
    - Register → confirm code → log in.
    - Tradie onboards payouts → homeowner books → pays with card `4242 4242 4242 4242`.
    - Stripe CLI: `stripe trigger payment_intent.succeeded`.
11. Then release the frontend: `feat/e2e-tests` in `homelink-team-26-frontend` holds the matching UI (it includes `backup/staging-2026-10-18` plus fixes found by the end-to-end tests). Merge it into `staging` for Amplify to build. Deploy the backend first: the frontend relies on the backend's week-range availability and hash-route Stripe return links.

## Decisions for you

- **Keep data on stack deletion?** Recommended: set `removalPolicy: RETAIN` on the tables and user pool before real users sign up. It doesn't recreate anything, but it means `cdk destroy` leaves them behind for you to delete by hand.
- **Allowed origins:** the commands above allow the Amplify staging site and the Capacitor apps. Add your production domain when you have one.
- **SES sender address** for verification emails.

## Rollback

Redeploy the previous commit (`git checkout main && npm run install:lambdas && npx cdk deploy`). That removes the new index and clients and restores the old functions. Users, bookings and payments stay in their tables, because no table is recreated in either direction.
