#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_BASE = String(
  process.env.HOMELINK_DEMO_API_BASE
    || 'https://wq95aewird.execute-api.ap-southeast-2.amazonaws.com/prod'
).replace(/\/$/, '');
const WEB_BASE = String(
  process.env.HOMELINK_DEMO_WEB_BASE
    || 'https://staging.d8ahda75tw3qj.amplifyapp.com'
).replace(/\/$/, '');
const OUTPUT = path.resolve(
  process.env.HOMELINK_DEMO_OUTPUT || '.demo-accounts.local.json'
);

if (process.env.HOMELINK_DEMO_TARGET !== 'staging') {
  fail('Refusing to create demo users. Set HOMELINK_DEMO_TARGET=staging explicitly.');
}

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const accounts = {
  homeowner: {
    email: process.env.HOMELINK_DEMO_HOMEOWNER_EMAIL || `homelink-demo-homeowner-${runId}@example.com`,
    password: process.env.HOMELINK_DEMO_HOMEOWNER_PASSWORD || password(),
    role: 'homeowner',
    name: 'HomeLink Demo Homeowner',
  },
  tradie: {
    email: process.env.HOMELINK_DEMO_TRADIE_EMAIL || `homelink-demo-tradie-${runId}@example.com`,
    password: process.env.HOMELINK_DEMO_TRADIE_PASSWORD || password(),
    role: 'tradie',
    name: 'HomeLink Demo Electrician',
    location: 'Brisbane',
    hourlyRate: 110,
    trade: 'Electrical',
  },
};

async function main() {
  const homeowner = await provision(accounts.homeowner);
  const tradie = await provision(accounts.tradie);

  await api('/schedule/me', {
    method: 'PATCH',
    token: tradie.tokens.idToken,
    body: {
      workingHours: standardWeek(),
      travelBuffer: 30,
    },
  });

  let booking = null;
  let bookingSetupError = null;
  try {
    booking = await api('/bookings', {
      method: 'POST',
      token: homeowner.tokens.idToken,
      body: {
        tradieId: tradie.user.userId,
        date: nextWeekday(),
        startTime: '10:00',
        endTime: '11:00',
        jobType: 'Electrical',
        description: 'Demo booking for team testing. Replace a faulty light switch.',
        serviceAddress: 'Team demo address, Brisbane QLD',
        serviceLocation: { latitude: -27.4698, longitude: 153.0251, accuracy: 50 },
      },
    });

    await api(`/messages/booking/${encodeURIComponent(booking.bookingId)}`, {
      method: 'POST',
      token: homeowner.tokens.idToken,
      body: { message: 'This is a private staging demo conversation for the HomeLink team.' },
    });
  } catch (error) {
    bookingSetupError = error.message;
  }

  const result = {
    createdAt: new Date().toISOString(),
    environment: 'staging',
    apiBase: API_BASE,
    note: 'Keep this file private. These users are filtered out of public search because their names and emails are marked as demo data.',
    homeowner: publicAccount(accounts.homeowner, homeowner.user),
    tradie: {
      ...publicAccount(accounts.tradie, tradie.user),
      privateProfileUrl: `${WEB_BASE}/#/tradie?id=${encodeURIComponent(tradie.user.userId)}`,
    },
    seededBookingId: booking?.bookingId || null,
    bookingSetupError,
  };

  fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Created two staging demo users. Credentials were written to ${OUTPUT}\n`);
  if (bookingSetupError) {
    process.stdout.write(`The users work, but the sample booking could not be prepared: ${bookingSetupError}\n`);
  }
}

async function provision(account) {
  let registered;
  try {
    registered = await api('/auth/register', { method: 'POST', body: account });
  } catch (error) {
    if (error.status !== 409) throw error;
  }

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  const user = login.user || registered;
  if (!user?.userId || !login.idToken) throw new Error(`Demo login did not return a complete session for ${account.role}`);
  return { user, tokens: login };
}

async function api(route, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${API_BASE}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || String(data) || response.statusText);
    error.status = response.status;
    throw error;
  }
  return data;
}

function publicAccount(account, user) {
  return {
    role: account.role,
    name: account.name,
    email: account.email,
    password: account.password,
    userId: user.userId,
    loginUrl: `${WEB_BASE}/#/login`,
  };
}

function standardWeek() {
  const on = { start: '07:00', end: '19:00' };
  return {
    Monday: on,
    Tuesday: on,
    Wednesday: on,
    Thursday: on,
    Friday: on,
    Saturday: { start: '08:00', end: '16:00' },
    Sunday: { off: true },
  };
}

function nextWeekday() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 2);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function password() {
  return `Aa1!${crypto.randomBytes(14).toString('base64url')}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((error) => fail(`Demo account setup failed: ${error.message}`));
