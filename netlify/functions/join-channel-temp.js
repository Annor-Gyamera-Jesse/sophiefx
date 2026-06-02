/**in future maybe i will do the manual thing lol
 *  ============================================================
 * SOPHIE FX — join-channel.js
 * Netlify Function: GET /.netlify/functions/join-channel
 *
 * One-time gate for the WhatsApp channel join link.
 * ONLY refs that correspond to a VERIFIED PAYMENT may pass.
 * Each booking_ref can then pass through ONCE.
 *
 * "Verified" = a row exists in the `bookings` table for this ref.
 * That table is only ever written by verify-payment.js AFTER
 * Paystack confirms status=success + matching amount + currency.
 * So presence in `bookings` == the payment was genuinely verified.
 *
 * Flow:
 *   1. Client clicks button in confirmation email
 *   2. This function receives ?ref=SA-XXXXXXXX-XXXX
 *   3. Validates the ref format
 *   4. Checks the `bookings` table  → no row → "not verified" page
 *   5. Checks the `channel_joins` table
 *      - First visit  → marks as used → 302 redirect to WhatsApp channel
 *      - Second visit → returns a "link already used" HTML page
 *   6. Missing/bad ref → returns an error page
 *
 * ENV VARS REQUIRED (already in your Netlify dashboard):
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your monitor token (used for origin check)
 *
 * Supabase tables (already created in your project):
 *   bookings      (reference PK, booking_ref, tier, amount, ...)
 *   channel_joins (booking_ref PK, used_at, ip, user_agent)
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const WHATSAPP_CHANNEL_URL = 'https://chat.whatsapp.com/GX9hG1iC6Q99OjtnfoAzTt';

// ── Supabase helpers ─────────────────────────────────────────

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

async function ensureTable() {
  // Best-effort. The table already exists in your project, so this is
  // a harmless no-op; kept only so a fresh project still bootstraps.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        query: `
          CREATE TABLE IF NOT EXISTS channel_joins (
            booking_ref TEXT PRIMARY KEY,
            used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ip          TEXT,
            user_agent  TEXT
          );
        `,
      }),
    });
  } catch (_) {
    // Silently ignore — table likely already exists
  }
}

// Look up a VERIFIED booking. The join link carries state.bookingRef,
// which in your data is stored in both `booking_ref` and `reference`,
// so we match on either to be safe. Throws on a transient DB error so
// the handler can show a "try again" page instead of wrongly blocking.
async function getBooking(bookingRef) {
  const ref = encodeURIComponent(bookingRef);
  const res = await sbFetch(
    `bookings?or=(booking_ref.eq.${ref},reference.eq.${ref})&select=booking_ref,reference&limit=1`,
    { method: 'GET', headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) {
    throw new Error(`bookings lookup failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows?.[0] || null;
}

async function getJoin(bookingRef) {
  const res = await sbFetch(
    `channel_joins?booking_ref=eq.${encodeURIComponent(bookingRef)}&select=booking_ref,used_at`,
    { method: 'GET', headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] || null;
}

async function markUsed(bookingRef, ip, userAgent) {
  const res = await sbFetch('channel_joins', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      booking_ref: bookingRef,
      ip:          ip || null,
      user_agent:  userAgent ? userAgent.slice(0, 300) : null,
    }),
  });
  return res.ok;
}

// ── HTML pages ───────────────────────────────────────────────

function alreadyUsedPage(bookingRef, usedAt) {
  const usedDate = usedAt
    ? new Date(usedAt).toLocaleString('en-GB', { timeZone: 'Africa/Accra', dateStyle: 'medium', timeStyle: 'short' })
    : 'earlier';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Link Already Used — Sophie FX</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      background:#0a0907;
      color:#f7f1e4;
      font-family:'Helvetica Neue',Arial,sans-serif;
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .card{
      background:#14120d;
      border:1px solid #2a261d;
      border-top:3px solid #e07060;
      max-width:480px;
      width:100%;
      padding:40px 36px;
      text-align:center;
    }
    .icon{font-size:40px;margin-bottom:18px;}
    h1{
      font-family:Georgia,serif;
      font-weight:400;
      font-size:22px;
      color:#f7f1e4;
      margin-bottom:12px;
    }
    p{
      color:#8a8170;
      font-size:14px;
      line-height:1.7;
      margin-bottom:10px;
    }
    .ref{
      font-family:'Courier New',monospace;
      font-size:11px;
      letter-spacing:1.5px;
      color:#e0b35a;
      background:#1c1913;
      padding:8px 14px;
      display:inline-block;
      margin:14px 0;
      border:1px solid #2a261d;
    }
    .contact{
      margin-top:28px;
      padding-top:20px;
      border-top:1px solid #2a261d;
      font-size:13px;
      color:#6a6050;
    }
    .contact a{color:#e0b35a;text-decoration:none;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1>This link has already been used</h1>
    <p>The WhatsApp channel join link for booking</p>
    <div class="ref">${bookingRef}</div>
    <p>was already activated on <strong style="color:#d2c7af">${usedDate}</strong>.</p>
    <p style="margin-top:14px;">Each booking confirmation contains a single-use link. If you believe this is an error, please contact Sophie directly.</p>
    <div class="contact">
      Need help? &nbsp;<a href="mailto:Pipsbuiltacademy@gmail.com">Pipsbuiltacademy@gmail.com</a>
    </div>
  </div>
</body>
</html>`;
}

function notVerifiedPage(bookingRef) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Payment Not Verified — Sophie FX</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      background:#0a0907;color:#f7f1e4;
      font-family:'Helvetica Neue',Arial,sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .card{
      background:#14120d;border:1px solid #2a261d;border-top:3px solid #e0b35a;
      max-width:480px;width:100%;padding:40px 36px;text-align:center;
    }
    .icon{font-size:40px;margin-bottom:18px;}
    h1{font-family:Georgia,serif;font-weight:400;font-size:22px;color:#f7f1e4;margin-bottom:12px;}
    p{color:#8a8170;font-size:14px;line-height:1.7;margin-bottom:10px;}
    .ref{
      font-family:'Courier New',monospace;font-size:11px;letter-spacing:1.5px;
      color:#e0b35a;background:#1c1913;padding:8px 14px;display:inline-block;
      margin:14px 0;border:1px solid #2a261d;
    }
    .contact{margin-top:28px;padding-top:20px;border-top:1px solid #2a261d;font-size:13px;color:#6a6050;}
    .contact a{color:#e0b35a;text-decoration:none;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏳</div>
    <h1>We couldn't confirm this payment yet</h1>
    <p>We don't have a verified payment on record for booking</p>
    <div class="ref">${bookingRef}</div>
    <p>If you paid by <strong style="color:#d2c7af">card or mobile money</strong>, this should clear within a minute — please open the link again shortly.</p>
    <p style="margin-top:10px;">If you paid by <strong style="color:#d2c7af">manual bank transfer</strong>, your spot is reserved. This link unlocks as soon as Sophie confirms your payment.</p>
    <div class="contact">
      Need help? &nbsp;<a href="mailto:Pipsbuiltacademy@gmail.com">Pipsbuiltacademy@gmail.com</a>
    </div>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Invalid Link — Sophie FX</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      background:#0a0907;color:#f7f1e4;
      font-family:'Helvetica Neue',Arial,sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .card{
      background:#14120d;border:1px solid #2a261d;border-top:3px solid #e07060;
      max-width:480px;width:100%;padding:40px 36px;text-align:center;
    }
    .icon{font-size:40px;margin-bottom:18px;}
    h1{font-family:Georgia,serif;font-weight:400;font-size:22px;color:#f7f1e4;margin-bottom:12px;}
    p{color:#8a8170;font-size:14px;line-height:1.7;}
    .contact{margin-top:28px;padding-top:20px;border-top:1px solid #2a261d;font-size:13px;color:#6a6050;}
    .contact a{color:#e0b35a;text-decoration:none;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Invalid or missing link</h1>
    <p>${message || 'This join link is invalid. Please use the link from your booking confirmation email.'}</p>
    <div class="contact">
      Need help? &nbsp;<a href="mailto:Pipsbuiltacademy@gmail.com">Pipsbuiltacademy@gmail.com</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Handler ──────────────────────────────────────────────────

export const handler = async (event) => {

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('Server configuration error. Please contact Sophie.'),
    };
  }

  // ── Extract & validate booking ref ──────────────────────────
  const bookingRef = (event.queryStringParameters?.ref || '').trim();

  if (!bookingRef) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('No booking reference found in this link.'),
    };
  }

  // Basic format guard — accepts SA-XXXXXXXX-XXXX (current) and BK-XXXXXX (legacy)
  if (!/^(SA|BK)-[A-Z0-9]{4,12}(-[A-Z0-9]{1,6})?$/i.test(bookingRef)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('This link does not contain a valid booking reference.'),
    };
  }

  // ── Gate: payment must be VERIFIED (present in the bookings table) ──
  let booking;
  try {
    booking = await getBooking(bookingRef);
  } catch (err) {
    // Transient DB error — don't wrongly admit, don't wrongly block.
    // Ask them to retry rather than silently failing open.
    console.error('[join-channel] bookings lookup error:', err.message);
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('We could not verify your booking right now. Please open the link again in a moment, or contact Sophie if it keeps happening.'),
    };
  }

  if (!booking) {
    // No verified payment on record for this ref → do NOT let them in.
    console.warn('[join-channel] ✗ Blocked — no verified booking for', bookingRef);
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'text/html' },
      body: notVerifiedPage(bookingRef),
    };
  }

  // ── Ensure table exists ──────────────────────────────────────
  await ensureTable();

  // ── Check if already used ────────────────────────────────────
  const existing = await getJoin(bookingRef);

  if (existing) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: alreadyUsedPage(bookingRef, existing.used_at),
    };
  }

  // ── First use — mark & redirect ──────────────────────────────
  const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
           || event.headers?.['client-ip']
           || null;

  const userAgent = event.headers?.['user-agent'] || null;

  const marked = await markUsed(bookingRef, ip, userAgent);

  if (!marked) {
    // Race condition: another request snuck in — check again
    const doubleCheck = await getJoin(bookingRef);
    if (doubleCheck) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: alreadyUsedPage(bookingRef, doubleCheck.used_at),
      };
    }
    // Genuine DB error — still let them through to avoid penalising a real
    // (and now verified) user.
    console.error('[join-channel] markUsed failed for', bookingRef);
  }

  console.log('[join-channel] ✓ Verified + first use — redirecting', bookingRef, 'to channel');

  // 302 redirect straight to WhatsApp
  return {
    statusCode: 302,
    headers: {
      'Location':      WHATSAPP_CHANNEL_URL,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
    body: '',
  };
};