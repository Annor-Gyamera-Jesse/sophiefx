/**
 * ============================================================
 * SOPHIE FX — join-channel.js
 * Netlify Function: GET /.netlify/functions/join-channel
 *
 * One-time gate for the WhatsApp channel join link.
 * Each booking_ref can only pass through ONCE.
 *
 * Flow:
 *   1. Client clicks button in confirmation email
 *   2. This function receives ?ref=BK-XXXXXX
 *   3. Checks Supabase `channel_joins` table
 *   4. First visit  → marks as used → 302 redirect to WhatsApp channel
 *   5. Second visit → returns a "link already used" HTML page
 *   6. Missing/bad ref → returns an error page
 *
 * ENV VARS REQUIRED (already in your Netlify dashboard):
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your monitor token (used for origin check)
 *
 * Supabase table (auto-created on first cold start):
 *   channel_joins (
 *     booking_ref TEXT PRIMARY KEY,
 *     used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     ip          TEXT,
 *     user_agent  TEXT
 *   )
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb8KAD87DAX2iNNp9x0z';

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
  // Use Supabase's SQL endpoint to create the table if it doesn't exist.
  // This is best-effort — if it fails the function still works on existing tables.
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
      Need help? &nbsp;<a href="mailto:andersonwalker509@gmail.com">andersonwalker509@gmail.com</a>
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
      Need help? &nbsp;<a href="mailto:andersonwalker509@gmail.com">andersonwalker509@gmail.com</a>
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

  // Basic format guard — booking refs look like BK-XXXXXXXX
  if (!/^BK-[A-Z0-9]{6,12}$/i.test(bookingRef)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: errorPage('This link does not contain a valid booking reference.'),
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
    // Genuine DB error — still let them through to avoid penalising a real user
    console.error('[join-channel] markUsed failed for', bookingRef);
  }

  console.log('[join-channel] ✓ First use — redirecting', bookingRef, 'to channel');

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