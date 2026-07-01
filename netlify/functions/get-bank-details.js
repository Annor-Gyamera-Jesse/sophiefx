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
  const accountName      = process.env.ZENITH_ACCOUNT_NAME;
  const accountGhs       = process.env.ZENITH_ACCOUNT_GHS;
  const beneficiaryName  = process.env.ZENITH_BENEFICIARY_NAME;
  const beneficiaryAcc   = process.env.ZENITH_BENEFICIARY_ACC;

  if (!accountName || !accountGhs) {
    console.error('[get-bank-details] Bank env vars not configured');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Bank details not configured — contact the team directly.' }),
    };
  }

  // ── Crypto wallet address ─────────────────────────────────────
  // TODO: Replace dummy address with Sophie's real USDT TRC20 wallet address
  // then add it as a Netlify env var: USDT_TRC20_ADDRESS

  const usdt_trc20 = process.env.USDT_TRC20_ADDRESS || null; // e.g. TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  ← SWAP THIS

  // USD wire instructions — intermediary details are fixed (Zenith Bank Ghana correspondent banks)
  // Only show USD section if Sophie's beneficiary account is configured
  const usd = (beneficiaryName && beneficiaryAcc) ? {
    beneficiary_name: beneficiaryName,
    beneficiary_acc:  beneficiaryAcc,
    beneficiary_bank: 'Zenith Bank Ghana',
    swift:            'ZEBLGHAC',
    // Two corridors — customer picks whichever their bank supports
    corridors: [
      {
        label:            'via JP Morgan Chase (recommended)',
        intermediary:     'JP Morgan Chase',
        intermediary_swift: 'CHASUS33',
        intermediary_acc: '464650998',
      },
      {
        label:            'via Citibank New York',
        intermediary:     'Citibank New York',
        intermediary_swift: 'CITIUS33',
        aba:              '021000089',
        intermediary_acc: '36250618',
      },
    ],
  } : null;

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      bank: {
        name:         'Zenith Bank Ghana',
        account_name: accountName,
        ghs: {
          label:   'Ghana Cedis (GH₵)',
          account: accountGhs,
        },
        usd,
        // Crypto — null if env var not set, frontend handles gracefully
        usdt_trc20,
      },
    }),
  };
};