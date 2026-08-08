# Backend Features Analysis — HomeLink

**Last Updated:** August 8, 2026  
**Status:** Currently running as a frontend-only demo with mock data  
**Project:** HomeLink — tradies marketplace (React + Vite)

---

## Current Architecture

The app is **fully client-side** with no backend. All state is held in memory (with optional localStorage persistence).

### Key Points
- No API calls anywhere in the codebase
- No database — seed data is deterministic and hardcoded
- No authentication (login just picks an account type)
- No real payments (checkout form validates locally only)
- No real-time messaging or notifications
- All bookings, messages, reviews, and availability are derived in-memory

---

## Core Business Logic (Currently In-Memory)

These features are **implemented on the frontend** and would need to move to a backend:

### 1. **Availability Engine** (`scripts/availability.js`)
**What it does:**
- Derives available time slots from: working hours − marked-unavailable dates − accepted bookings
- Prevents double bookings with half-open interval logic: `[start, end)`
- Applies travel buffer at query time (no phantom bookings written)
- Single state precedence: `past → too-soon → day-off → off-hours → blocked → booked → buffer → pending → available`

**Current:** Pure, testable function with injected time (no `Date.now()` calls)  
**For backend:** Move to server; expose endpoints for querying availability per tradie/date  

**Endpoints Needed:**
- `GET /availability/tradie/{tradie_id}?date={YYYY-MM-DD}` → list of available hours
- `GET /availability/tradie/{tradie_id}?from={date}&to={date}` → date range availability
- `POST /availability/check` → validate a slot is available before booking

---

### 2. **Booking Management** (`scripts/store.js`)
**What it does:**
- One write path guarded by `canBook()` (throws on conflict)
- Bookings tracked with: id, homeowner, tradie, date, time, jobType, description, status
- Status lifecycle: `pending → accepted/declined → completed → reviewed`
- Prevents double bookings at write time

**Current:** All in-memory, one write path  
**For backend:** Move to database; expose booking CRUD endpoints

**Endpoints Needed:**
- `POST /bookings` → create booking (will call availability.canBook() server-side)
- `GET /bookings?user_id={id}&role={homeowner|tradie}` → user's bookings
- `PATCH /bookings/{id}` → accept/decline/complete/cancel
- `GET /bookings/{id}` → single booking details

---

### 3. **Pricing & Commission** (`scripts/pricing.js`)
**What it does:**
- Calculates: 10% commission (tradie), 5% service fee (homeowner), HomeLink Pro ($149/mo removes 10%)
- Keeps math in one place so all screens agree on final price
- No screen multiplies by rate directly; all use derived totals

**Current:** Pure function on frontend  
**For backend:** Move calculations to server for consistency and fraud prevention

**Endpoints Needed:**
- `POST /pricing/calculate` → body: `{hourly_rate, hours, has_pro}` → returns breakdown
- `GET /pricing/breakdown/{booking_id}` → fetch pricing for a specific booking

---

### 4. **Account & Profile** (`scripts/accounts.js` + `scripts/me.js`)
**What it does:**
- Demo accounts: Ravi Deshmukh (homeowner), Nadia Brennan (tradie)
- Tradie profile: name, rate, years, rating, bio, services, photo gallery
- Homeowner profile: name, address, payment method

**Current:** Hardcoded seed data, no writes except for settings  
**For backend:** Move profiles to database; add full CRUD for tradie setup, updates

**Endpoints Needed:**
- `GET /profiles/tradie/{tradie_id}` → full tradie profile + stats
- `GET /profiles/homeowner/{homeowner_id}` → homeowner profile
- `PATCH /profiles/me` → update own profile
- `POST /profiles/tradie` → register as tradie (during onboarding)

---

### 5. **Reviews & Ratings** (`scripts/ratings.js`)
**What it does:**
- One write path: only after completed job, only by the counterparty, only once per booking
- Rating derivation: average of all reviews for a tradie
- Ratings appear on: profile, market card, search filter floor (4.0+, 4.5+, 4.8+)

**Current:** In-memory, hardcoded reviews in seed  
**For backend:** Move to database; track per-tradie aggregates

**Endpoints Needed:**
- `POST /reviews` → create review for a booking (must check: completed, owned by caller, not already reviewed)
- `GET /reviews/tradie/{tradie_id}` → list reviews + computed rating
- `GET /reviews?booking_id={id}` → review for this booking (if it exists)

---

### 6. **Messages / Chat** (`scripts/chat.js`)
**What it does:**
- One thread per booking (not per tradie)
- Messages tied to booking id and thread
- Deterministic opener assignment (no collisions)
- No real-time messaging

**Current:** In-memory seed messages, no write path  
**For backend:** Move to database; expose message CRUD

**Endpoints Needed:**
- `GET /messages/booking/{booking_id}` → thread history
- `POST /messages/booking/{booking_id}` → send message
- `GET /messages?user_id={id}` → list of conversations (one per booking)

---

### 7. **Notifications** (`scripts/notify.js`)
**What it does:**
- Derived from bookings state
- No persistent storage; alerts are **computed** from booking status
- Examples: new booking request, booking accepted, reminder tomorrow, job completed

**Current:** Computed on-demand from seed bookings  
**For backend:** Derive from booking events or compute on request

**Endpoints Needed:**
- `GET /notifications?user_id={id}` → current alerts
- `PATCH /notifications/{notification_id}` → mark as read (optional, can be computed)

---

### 8. **Session & Auth** (`scripts/session.js`)
**What it does:**
- Picks account type and resolves to a demo account
- Stores role in localStorage and URL
- No real authentication

**Current:** No backend auth  
**For backend:** Replace with real OAuth or JWT-based auth

**Endpoints Needed:**
- `POST /auth/login` → body: `{email, password, role}` → returns token + user
- `POST /auth/logout` → invalidate session
- `GET /auth/me` → current user + role
- `POST /auth/register` → create new account

---

### 9. **Search & Filter** (`scripts/accounts.js` - filter logic)
**What it does:**
- Filter by: trade, location, availability (named day), rating floor
- URL is the query: `search.html?trade=Plumber&free=2026-08-08&rating=45`
- Availability filter is a real scan of calendars, not a guess

**Current:** Filters hardcoded 20 tradies in-memory  
**For backend:** Move to database with indexed search

**Endpoints Needed:**
- `GET /search?trade={type}&location={suburb}&free={date}&rating_min={4.0|4.5|4.8}` → filtered tradies list
- `GET /trades` → list of available trade types
- `GET /locations` → list of work locations

---

### 10. **Working Hours & Schedule** (`scripts/schedule.js`)
**What it does:**
- Tradie sets working hours per day (e.g., 9am–5pm Mon–Fri)
- Marks days off manually
- Travel buffer added to bookings (e.g., 30 mins between jobs)

**Current:** In-memory, no write path in demo  
**For backend:** Move to database; expose schedule CRUD

**Endpoints Needed:**
- `GET /schedule/tradie/{tradie_id}` → working hours + days off
- `PATCH /schedule/me` → update own working hours
- `POST /schedule/me/unavailable` → mark day off
- `DELETE /schedule/me/unavailable/{date}` → remove day off

---

## Feature Readiness Matrix

| Feature | Current | Needed for Backend | Difficulty | Priority |
|---------|---------|-------------------|------------|----------|
| **Availability** | ✅ Implemented (frontend) | Move to server | High (core logic) | 🔴 P0 |
| **Bookings** | ✅ Implemented (frontend) | DB + CRUD endpoints | Medium | 🔴 P0 |
| **Pricing** | ✅ Implemented (frontend) | Move to server | Low | 🟠 P1 |
| **Accounts/Profiles** | ✅ Seed data only | Full DB + CRUD | Medium | 🔴 P0 |
| **Reviews** | ✅ Seed data only | DB + write guard | Medium | 🟠 P1 |
| **Messages** | ✅ Seed data only | DB + real-time (optional) | Medium | 🟠 P1 |
| **Notifications** | ✅ Computed (frontend) | Compute on server/DB query | Low | 🟡 P2 |
| **Auth** | ❌ None (role picker) | Full JWT/OAuth | Medium | 🔴 P0 |
| **Search** | ✅ Filters 20 tradies | DB index + query | Low | 🟠 P1 |
| **Schedule** | ✅ Seed data | DB + CRUD | Low | 🟠 P1 |

---

## Reachable Backend Features (Today)

These can be built **right now** on the frontend, no backend needed:

### Immediately Accessible
1. ✅ **Availability derivation** — already a pure function, fully testable
2. ✅ **Booking conflict detection** — `canBook()` logic is complete
3. ✅ **Calendar rendering** — uses derived availability, no backend
4. ✅ **Pricing calculation** — pure math, no state dependency
5. ✅ **Profile display** — reads from seed data
6. ✅ **Review derivation** — computes rating from seed reviews
7. ✅ **Message threading** — organized by booking id
8. ✅ **Notification computation** — derived from booking state
9. ✅ **Search filter logic** — parametrized, works with mock data
10. ✅ **Schedule conflict detection** — blocked time slots prevent overlaps

### Limited (Seed Data Only)
- Authentication (role picker, no real login)
- Data persistence (localStorage, survives refresh)
- Multi-user scenarios (hardcoded demo accounts only)

---

## What's Missing for Production

### Required Before Backend Integration
1. **Real authentication** — JWT or OAuth to replace role picker
2. **User registration** — endpoint to create accounts
3. **Payment processing** — Stripe, Square, or similar for HomeLink Pro
4. **Image uploads** — tradie photos, job gallery images
5. **Email notifications** — real alerts (booking confirmed, etc.)
6. **Real-time messaging** — WebSocket or polling for live chat
7. **Admin dashboard** — manage disputes, commission payouts
8. **Reporting** — fraud detection, analytics

---

## Suggested Backend Stack

Based on the feature set, a backend could be:

### Minimal (MVP)
- **Node.js + Express** or **Python + FastAPI**
- **PostgreSQL** for bookings, profiles, reviews
- **Redis** for availability cache (computed on-demand)
- **JWT** for auth
- **Stripe** for payments

### Scalable
- Add **Kafka** for real-time booking events
- Add **WebSocket** server for live chat
- Add **S3** for image storage
- Add **Elasticsearch** for search indexing

---

## Integration Points (Frontend ↔ Backend)

### Phase 1: Auth + Profiles
```
Frontend                Backend
login.html          → POST /auth/login
home.html           → GET /auth/me
                    → GET /profiles/{user_id}
```

### Phase 2: Availability + Bookings
```
book.html           → GET /availability/{tradie_id}/{date}
                    → POST /bookings (calls availability.canBook() server-side)
calendar.html       → GET /bookings?user_id={id}
                    → PATCH /bookings/{id} (accept/decline/complete)
```

### Phase 3: Reviews + Messaging
```
reviews.html        → POST /reviews
                    → GET /reviews/tradie/{tradie_id}
messages.html       → GET /messages/booking/{booking_id}
                    → POST /messages/booking/{booking_id}
```

### Phase 4: Search + Premium
```
search.html         → GET /search?trade={type}&rating={floor}&free={date}
premium.html        → POST /checkout (process HomeLink Pro purchase)
```

---

## Current Test Coverage

The frontend has **extensive tests** (from README):
- `availability.test.js` — 46 assertions
- `home.test.js` — 104 assertions
- `calendar.test.js` — 61 assertions
- `bookings.test.js` — 65 assertions
- `chat.test.js` — 37 assertions
- `account.test.js` — 33 assertions
- `book.test.js` — 39 assertions
- `pricing.test.js` — 65 assertions
- `checkout.test.js` — 46 assertions

**Total: 495+ unit tests validating core logic**

These tests should be ported to backend tests to ensure server-side derivations match frontend expectations.

---

## Next Steps

1. **Define API contract** — OpenAPI/GraphQL spec for all endpoints listed above
2. **Implement auth** — JWT-based login/register
3. **Migrate availability** — move derivation to server, expose via API
4. **Migrate bookings** — DB schema + CRUD endpoints
5. **Migrate profiles** — user accounts, tradie profiles
6. **Add payments** — Stripe integration for HomeLink Pro
7. **Port tests** — ensure server logic matches frontend expectations

---

## Files Reference

### Frontend (React)
- `src/App.jsx` — main app shell
- `src/pages/` — route pages (Login, Home, Search, etc.)
- `src/components/` — reusable UI components
- `src/state/` — global state management (if any)
- `src/hooks/` — custom React hooks
- `src/lib/` — utilities and helper functions

### Legacy (Vanilla JS — historical reference)
- `legacy/scripts/availability.js` — **core availability logic**
- `legacy/scripts/store.js` — booking writes
- `legacy/scripts/accounts.js` — profile + filter logic
- `legacy/scripts/pricing.js` — commission math
- `legacy/scripts/ratings.js` — review derivation
- `legacy/scripts/chat.js` — message threading
- `legacy/scripts/session.js` — auth (placeholder)

### Build & Deploy
- `vite.config.js` — frontend build config
- `package.json` — npm dependencies (React, React Router)
- `vercel.json` — Vercel deployment config (no build step needed)

---

## Conclusion

**The app is feature-complete for a frontend demo but has zero backend.** All business logic is correctly implemented on the client side and works well for a walkthrough. Moving to production requires:

1. Moving availability, bookings, and pricing to a server
2. Building real auth (replace role picker)
3. Adding a database (PostgreSQL recommended)
4. Integrating payments (Stripe)
5. Adding real-time features (WebSocket for chat)

The current test suite (495+ tests) is a strong foundation for backend validation — porting these to server-side tests will ensure the transition maintains correctness.
