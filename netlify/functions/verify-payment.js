/**
 * ============================================================
 * SOPHIE FX — Netlify Serverless Function
 * File location in your repo: netlify/functions/verify-payment.js
 *
 * Environment variables to set in Netlify dashboard:
 *   PAYSTACK_SECRET_KEY  =  sk_live_xxxxxxxxxxxxxxxxxxxxxxxx
 *   ALLOWED_ORIGIN       =  https://your-site.netlify.app
 *   SUPABASE_URL         =  https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY =  your service_role key
 * ============================================================
 */

import { Pool } from 'pg';
import crypto from 'crypto';

const DATABASE_URL         = process.env.DATABASE_URL;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
if (!DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set; booking persistence disabled');
} else {
  initPostgres().catch(err => console.error('[db] init failed', err));
}

// ── Netlify Functions entry point ──────────────────────────
export const handler = async (event, context) => {

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    console.error('[verify] PAYSTACK_SECRET_KEY env var is not set');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

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
      body: JSON.stringify({ success: false, message: 'reference is required' }),
    };
  }

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
    console.error('[verify] Network error reaching Paystack:', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Could not reach Paystack' }),
    };
  }

  if (!psRes.ok) {
    console.error('[verify] Paystack returned HTTP', psRes.status);
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

  // ── The three checks that matter ──────────────────────────
  const statusOk   = tx.status === 'success';
  const amountOk   = !expected_amount_pesewas || Number(tx.amount) === Number(expected_amount_pesewas);
  const currencyOk = !expected_currency || tx.currency === expected_currency;

  if (!statusOk) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        message: `Transaction status: ${tx.status} — ${tx.gateway_response || 'not successful'}`,
        data: { status: tx.status, gateway_response: tx.gateway_response },
      }),
    };
  }

  if (!amountOk) {
    console.error(`[SECURITY] Amount mismatch for ref ${reference}: expected ${expected_amount_pesewas} pesewas, got ${tx.amount}`);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: `Amount mismatch — expected ${expected_amount_pesewas}, got ${tx.amount}` }),
    };
  }

  if (!currencyOk) {
    console.error(`[SECURITY] Currency mismatch for ref ${reference}: expected ${expected_currency}, got ${tx.currency}`);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: `Currency mismatch — expected ${expected_currency}, got ${tx.currency}` }),
    };
  }

  // ── All checks passed ─────────────────────────────────────
  const payload = {
    reference:        tx.reference,
    amount:           tx.amount,
    currency:         tx.currency,
    paid_at:          tx.paid_at,
    channel:          tx.channel,
    customer_email:   tx.customer?.email,
    customer_name:    `${tx.customer?.first_name || ''} ${tx.customer?.last_name || ''}`.trim(),
    gateway_response: tx.gateway_response,
    booking_ref:      tx.metadata?.booking_ref || booking_ref,
    tier:             tx.metadata?.tier,
  };

  // ── Side effects — run in parallel, never block the response ──
  await Promise.allSettled([
    persistBooking(payload).catch(err => console.error('[verify] booking persistence failed', err)),
    incrementDiscountUsed().catch(err => console.error('[verify] discount increment failed', err)),
  ]);

  console.log('[verify] ✓ Verified:', reference, '— GH₵', (tx.amount / 100).toFixed(2));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true, message: 'Verified', data: payload }),
  };
};

// ── Atomically increment discount.used in Supabase ────────────
// Only increments when discount is currently enabled — so
// payments made outside a discount window don't affect the count.
async function incrementDiscountUsed() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[discount] Supabase env vars not set — skipping increment');
    return;
  }

  // First read the current discount settings
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount&select=value`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });

  if (!getRes.ok) {
    console.warn('[discount] could not read settings:', getRes.status);
    return;
  }

  const rows = await getRes.json();
  const discount = rows?.[0]?.value;

  // Only increment if discount is actually enabled
  if (!discount || !discount.enabled) {
    console.log('[discount] discount not enabled — skipping increment');
    return;
  }

  const currentUsed = Number(discount.used) || 0;
  const newUsed     = currentUsed + 1;

  const updated = {
    ...discount,
    used: newUsed,
  };

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ value: updated, updated_at: new Date().toISOString() }),
  });

  if (!patchRes.ok) {
    const text = await patchRes.text();
    throw new Error(`Supabase PATCH failed: ${patchRes.status} ${text}`);
  }

  console.log(`[discount] ✓ used incremented: ${currentUsed} → ${newUsed} / ${discount.max_uses}`);

  // Warn if discount just hit its limit
  if (newUsed >= discount.max_uses) {
    console.warn(`[discount] ⚠ Discount limit reached (${newUsed}/${discount.max_uses}) — consider disabling it in admin`);
  }
}

// ── Persist booking to Postgres ────────────────────────────────
async function persistBooking(payload) {
  if (!pgPool) {
    console.warn('[persist] skipping Postgres persistence because DATABASE_URL is not set');
    return;
  }

  const sql = `
    INSERT INTO bookings (
      reference, booking_ref, tier, amount, currency,
      paid_at, channel, customer_email, customer_name, gateway_response
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (reference) DO UPDATE SET
      booking_ref      = EXCLUDED.booking_ref,
      tier             = EXCLUDED.tier,
      amount           = EXCLUDED.amount,
      currency         = EXCLUDED.currency,
      paid_at          = EXCLUDED.paid_at,
      channel          = EXCLUDED.channel,
      customer_email   = EXCLUDED.customer_email,
      customer_name    = EXCLUDED.customer_name,
      gateway_response = EXCLUDED.gateway_response;
  `;

  await pgPool.query(sql, [
    payload.reference, payload.booking_ref, payload.tier,
    payload.amount, payload.currency, payload.paid_at || null,
    payload.channel, payload.customer_email,
    payload.customer_name, payload.gateway_response,
  ]);
  console.log('[persist] saved booking', payload.reference);
}

async function initPostgres() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      reference        TEXT PRIMARY KEY,
      booking_ref      TEXT,
      tier             TEXT,
      amount           BIGINT NOT NULL,
      currency         TEXT NOT NULL,
      paid_at          TIMESTAMPTZ,
      channel          TEXT,
      customer_email   TEXT,
      customer_name    TEXT,
      gateway_response TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}