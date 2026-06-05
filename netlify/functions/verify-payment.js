/**
 * ============================================================
 * SOPHIE FX -- paystack-webhook.js
 * Netlify Function: POST /.netlify/functions/paystack-webhook
 *
 * Paystack POSTs a charge.success event here every time a
 * payment completes -- even if the user closed the browser
 * before onSuccess fired on the frontend.
 *
 * This is the safety net. verify-payment.js is the happy path.
 * Both persist the booking + increment discount used, BUT the
 * webhook checks if verify-payment.js already saved the booking
 * first -- if so, it skips the discount increment to prevent
 * double-counting the same payment.
 *
 * Register this URL in Paystack Dashboard:
 *   Settings -> API Keys & Webhooks -> Webhook URL
 *   https://your-site.netlify.app/.netlify/functions/paystack-webhook
 *
 * ENV VARS (already in your Netlify dashboard):
 *   PAYSTACK_SECRET_KEY  -- to verify the signature
 *   SUPABASE_URL         -- to persist bookings + increment discount
 *   SUPABASE_SERVICE_KEY -- service role key
 * ============================================================
 */

/**
 * ============================================================
 * PIPS BUILT ACADEMY — verify-payment.js
 * Netlify Function: POST /.netlify/functions/verify-payment
 *
 * Called by index.html after Paystack's onSuccess fires.
 * Hits Paystack's server-side verify endpoint using the SECRET
 * key, confirms amount + currency match, then persists the
 * booking to Supabase and increments the discount counter.
 *
 * ENV VARS REQUIRED:
 *   PAYSTACK_SECRET_KEY  = sk_live_xxxxxxxx
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your admin token
 *   ALLOWED_ORIGIN       = https://your-site.netlify.app
 * ============================================================
 */

const PAYSTACK_SECRET     = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── In-memory idempotency cache (24-hour TTL) ─────────────────
// Prevents the same reference being "verified" twice
// (e.g. user reloads the success page). In production you can
// swap this for a Redis check or a Supabase lookup.
const verifiedRefs = new Map();

function getCached(ref) {
  const entry = verifiedRefs.get(ref);
  if (!entry) return null;
  if (Date.now() - entry.at > 24 * 60 * 60 * 1000) { verifiedRefs.delete(ref); return null; }
  return entry;
}
function setCached(ref, payload) {
  verifiedRefs.set(ref, { at: Date.now(), payload });
}

// ── Supabase helpers ──────────────────────────────────────────
async function persistBooking(payload) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
  console.log('[verify] ✓ booking persisted:', payload.reference);
}

async function incrementDiscountUsed() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount&select=value`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });
  if (!getRes.ok) return;

  const rows     = await getRes.json();
  const discount = rows?.[0]?.value;
  if (!discount || !discount.enabled) return;

  const newUsed = (Number(discount.used) || 0) + 1;

  await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      value:      { ...discount, used: newUsed },
      updated_at: new Date().toISOString(),
    }),
  });

  console.log(`[verify] discount used: ${discount.used} → ${newUsed} / ${discount.max_uses}`);
  if (newUsed >= discount.max_uses) {
    console.warn(`[verify] ⚠ Discount limit reached (${newUsed}/${discount.max_uses})`);
  }
}

// ── Handler ───────────────────────────────────────────────────
export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Method not allowed' }),
    };
  }

  if (!PAYSTACK_SECRET) {
    console.error('[verify] PAYSTACK_SECRET_KEY not set');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

  // ── Parse body ────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Invalid JSON body' }),
    };
  }

  const { reference, expected_amount_pesewas, expected_currency, booking_ref } = body;

  if (!reference || typeof reference !== 'string') {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: '"reference" is required' }),
    };
  }

  // ── Idempotency check ─────────────────────────────────────────
  const cached = getCached(reference);
  if (cached) {
    console.log('[verify] cache hit for', reference);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Already verified', data: cached.payload, cached: true }),
    };
  }

  // ── Call Paystack verify ──────────────────────────────────────
  let psRes;
  try {
    psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('[verify] Paystack fetch error:', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Could not reach Paystack' }),
    };
  }

  if (!psRes.ok) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: `Paystack returned HTTP ${psRes.status}` }),
    };
  }

  const psBody = await psRes.json();
  const tx = psBody?.data;

  if (!tx) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Empty response from Paystack' }),
    };
  }

  // ── The three checks that matter ──────────────────────────────
  const statusOk   = tx.status === 'success';
  const amountOk   = !expected_amount_pesewas || Number(tx.amount) === Number(expected_amount_pesewas);
  const currencyOk = !expected_currency       || tx.currency === expected_currency;

  if (!statusOk) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: `Transaction status: ${tx.status} — ${tx.gateway_response || 'not successful'}`,
        data: { status: tx.status, gateway_response: tx.gateway_response },
      }),
    };
  }

  if (!amountOk) {
    console.error(`[SECURITY] Amount mismatch for ${reference}: expected ${expected_amount_pesewas}, got ${tx.amount}`);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: `Amount mismatch: expected ${expected_amount_pesewas}, got ${tx.amount}`,
      }),
    };
  }

  if (!currencyOk) {
    console.error(`[SECURITY] Currency mismatch for ${reference}: expected ${expected_currency}, got ${tx.currency}`);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: `Currency mismatch: expected ${expected_currency}, got ${tx.currency}`,
      }),
    };
  }

  // ── All checks passed — build payload ─────────────────────────
  const payload = {
    reference:        tx.reference,
    booking_ref:      tx.metadata?.booking_ref || booking_ref || null,
    tier:             tx.metadata?.tier || null,
    amount:           tx.amount,
    currency:         tx.currency,
    paid_at:          tx.paid_at || null,
    channel:          tx.channel || null,
    customer_email:   tx.customer?.email || null,
    customer_name:    `${tx.customer?.first_name || ''} ${tx.customer?.last_name || ''}`.trim() || null,
    gateway_response: tx.gateway_response || null,
  };

  setCached(reference, payload);

  // ── Side-effects (non-blocking — payment is confirmed regardless) ──
  try {
    await persistBooking(payload);
    await incrementDiscountUsed();
  } catch (sideErr) {
    console.error('[verify] post-verify side-effect failed:', sideErr.message);
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, message: 'Verified', data: payload }),
  };
};