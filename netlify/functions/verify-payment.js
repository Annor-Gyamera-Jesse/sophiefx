/**
 * ============================================================
 * SOPHIE FX — Netlify Serverless Function
 * File location in your repo: netlify/functions/verify-payment.js
 *
 * Environment variables to set in Netlify dashboard:
 *   PAYSTACK_SECRET_KEY  =  sk_live_xxxxxxxxxxxxxxxxxxxxxxxx
 *   ALLOWED_ORIGIN       =  https://your-site.netlify.app
 *                           (or your custom domain if you have one)
 * ============================================================
 */

import crypto from 'crypto';

// ── Netlify Functions entry point ──────────────────────────
// Every Netlify function exports a single `handler` function.
// Netlify calls it with (event, context) and expects a response
// object with { statusCode, headers, body }.
export const handler = async (event, context) => {

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || '*';

  // ── CORS headers — sent on every response ─────────────────
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // ── Preflight (browser sends OPTIONS before POST) ─────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // ── Only allow POST ────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Method not allowed' }),
    };
  }

  // ── Guard: secret key must be set ─────────────────────────
  if (!PAYSTACK_SECRET) {
    console.error('[verify] PAYSTACK_SECRET_KEY env var is not set');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

  // ── Parse request body ─────────────────────────────────────
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

  // ── Call Paystack verify API ───────────────────────────────
  // This is the ONLY place the secret key is ever used.
  // It never leaves this function — the browser never sees it.
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
      body: JSON.stringify({
        success: false,
        message: `Paystack returned HTTP ${psRes.status}`,
      }),
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
  const amountOk   = !expected_amount_pesewas ||
                     Number(tx.amount) === Number(expected_amount_pesewas);
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
    // Amount mismatch is a red flag — log it prominently
    console.error(
      `[SECURITY] Amount mismatch for ref ${reference}: ` +
      `expected ${expected_amount_pesewas} pesewas, got ${tx.amount}`
    );
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        message: `Amount mismatch — expected ${expected_amount_pesewas}, got ${tx.amount}`,
      }),
    };
  }

  if (!currencyOk) {
    console.error(
      `[SECURITY] Currency mismatch for ref ${reference}: ` +
      `expected ${expected_currency}, got ${tx.currency}`
    );
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        message: `Currency mismatch — expected ${expected_currency}, got ${tx.currency}`,
      }),
    };
  }

  // ── All checks passed ─────────────────────────────────────
  const payload = {
    reference:        tx.reference,
    amount:           tx.amount,
    currency:         tx.currency,
    paid_at:          tx.paid_at,
    channel:          tx.channel,           // card / mobile_money / bank / ussd
    customer_email:   tx.customer?.email,
    customer_name:    `${tx.customer?.first_name || ''} ${tx.customer?.last_name || ''}`.trim(),
    gateway_response: tx.gateway_response,
    booking_ref:      tx.metadata?.booking_ref || booking_ref,
    tier:             tx.metadata?.tier,
  };

  console.log('[verify] ✓ Verified:', reference, '— GH₵', (tx.amount / 100).toFixed(2));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true, message: 'Verified', data: payload }),
  };
};


// ============================================================
// WEBHOOK HANDLER
// ============================================================
// Netlify doesn't support two handlers in one file, so the
// webhook lives at a separate URL.
// Create a second file: netlify/functions/paystack-webhook.js
// and paste the content below into it.
// ============================================================
//
// export const handler = async (event) => {
//
//   if (event.httpMethod !== 'POST') {
//     return { statusCode: 405, body: 'Method not allowed' };
//   }
//
//   const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
//   const signature = event.headers['x-paystack-signature'];
//
//   if (!signature) return { statusCode: 400, body: 'No signature' };
//
//   const expected = crypto
//     .createHmac('sha512', PAYSTACK_SECRET)
//     .update(event.body)
//     .digest('hex');
//
//   if (signature !== expected) {
//     console.warn('[webhook] Signature mismatch');
//     return { statusCode: 401, body: 'Invalid signature' };
//   }
//
//   const evt = JSON.parse(event.body);
//   console.log('[webhook] event received:', evt.event, evt.data?.reference);
//
//   // Always return 200 fast — Paystack retries on non-2xx
//   return { statusCode: 200, body: 'OK' };
// };