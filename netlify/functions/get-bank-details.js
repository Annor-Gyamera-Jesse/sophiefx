/**
 * ============================================================
 * PIPS BUILT ACADEMY — get-bank-details.js
 * Netlify Function: GET /.netlify/functions/get-bank-details
 *
 * Bank account details NEVER live in the HTML source.
 * They sit in Netlify environment variables and are served
 * through this function only when a customer is actively on
 * the payment step. Anyone scraping the page source sees nothing.
 *
 * ENV VARS TO ADD IN NETLIFY DASHBOARD:
 *   ZENITH_ACCOUNT_NAME   = PipsBuiltAcademy          ← swap with real name
 *   ZENITH_ACCOUNT_GHS    = 1234567890                 ← GH₵ account number
 *   ZENITH_ACCOUNT_USD    = 9876543210                 ← USD domiciliary account number
 *   ZENITH_SWIFT          = ZEBLGHAC                   ← Zenith Bank Ghana SWIFT
 *
 * Rate limited to 20 requests per IP per minute so nobody
 * can bulk-scrape these details programmatically.
 * ============================================================
 */

const MONITOR_SECRET = process.env.MONITOR_SECRET;

// ── In-memory rate limiter — resets on Netlify cold start ─────
// 20 fetches per IP per minute is more than enough for a real user
const rateMap = new Map();
const RATE_LIMIT  = 20;
const RATE_WINDOW = 60 * 1000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.window > RATE_WINDOW) {
    rateMap.set(ip, { window: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
    // No caching — bank details must always come fresh
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  // ── Rate limit by IP ──────────────────────────────────────────
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Too many requests' }),
    };
  }

  // ── Validate the env vars are actually set ────────────────────
  const accountName = process.env.ZENITH_ACCOUNT_NAME;
  const accountGhs  = process.env.ZENITH_ACCOUNT_GHS;
  const accountUsd  = process.env.ZENITH_ACCOUNT_USD;
  const swift       = process.env.ZENITH_SWIFT;

  if (!accountName || !accountGhs) {
    console.error('[get-bank-details] Bank env vars not configured');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Bank details not configured — contact the team directly.' }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      bank: {
        name:        'Zenith Bank Ghana',
        account_name: accountName,
        ghs: {
          label:   'Ghana Cedis (GH₵)',
          account: accountGhs,
        },
        usd: accountUsd ? {
          label:   'US Dollar (USD) — Domiciliary',
          account: accountUsd,
          swift:   swift || 'ZEBLGHAC',
        } : null,
      },
    }),
  };
};
