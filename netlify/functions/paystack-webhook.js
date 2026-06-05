/**
 * ============================================================
 * SOPHIE FX — paystack-webhook.js
 * Netlify Function: POST /.netlify/functions/paystack-webhook
 *
 * Paystack POSTs a charge.success event here every time a
 * payment completes — even if the user closed the browser
 * before onSuccess fired on the frontend.
 *
 * This is the safety net. verify-payment.js is the happy path.
 * Both do the same thing: persist the booking + increment
 * discount used. The ON CONFLICT clause in Supabase means
 * running both for the same payment is always safe.
 *
 * Register this URL in Paystack Dashboard:
 *   Settings → API Keys & Webhooks → Webhook URL
 *   https://your-site.netlify.app/.netlify/functions/paystack-webhook
 *
 * ENV VARS (already in your Netlify dashboard):
 *   PAYSTACK_SECRET_KEY  — to verify the signature
 *   SUPABASE_URL         — to persist bookings + increment discount
 *   SUPABASE_SERVICE_KEY — service role key
 * ============================================================
 */

import crypto from 'crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const handler = async (event) => {

  // ── Only POST ──────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

  if (!PAYSTACK_SECRET) {
    console.error('[webhook] PAYSTACK_SECRET_KEY not set');
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  // ── Verify Paystack signature ──────────────────────────────
  // Paystack signs the raw body with your secret key using HMAC SHA512.
  // If the signature doesn't match, someone is spoofing the webhook.
  const signature = event.headers['x-paystack-signature'];

  if (!signature) {
    console.warn('[webhook] No signature header');
    return { statusCode: 400, body: 'No signature' };
  }

  const expected = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(event.body)
    .digest('hex');

  if (signature !== expected) {
    console.warn('[webhook] Signature mismatch — possible spoofed request');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // ── Parse event ────────────────────────────────────────────
  let evt;
  try {
    evt = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // ── ALWAYS return 200 immediately ──────────────────────────
  // Paystack retries on any non-2xx. Return fast, then do the work.
  // We do this by not awaiting side effects before responding.
  // (Netlify functions stay alive until the async work completes.)

  if (evt.event === 'charge.success') {
    const tx = evt.data;
    console.log('[webhook] charge.success —', tx.reference, tx.amount, tx.currency);

    // Fire and don't block the 200 response
    Promise.allSettled([
      persistBooking(tx).catch(err => console.error('[webhook] persistBooking failed:', err.message)),
      incrementDiscountUsed().catch(err => console.error('[webhook] incrementDiscount failed:', err.message)),
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[webhook] side-effect ${i} rejected:`, r.reason);
        }
      });
      console.log('[webhook] ✓ side-effects done for', tx.reference);
    });

  } else {
    // Log other event types but don't act on them
    console.log('[webhook] unhandled event type:', evt.event);
  }

  return { statusCode: 200, body: 'OK' };
};

// ── Persist booking to Supabase ────────────────────────────────
// Uses ON CONFLICT so re-running for the same reference is safe.
async function persistBooking(tx) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[webhook] Supabase env vars not set — skipping persist');
    return;
  }

  const payload = {
    reference:        tx.reference,
    booking_ref:      tx.metadata?.booking_ref || null,
    tier:             tx.metadata?.tier || null,
    amount:           tx.amount,
    currency:         tx.currency,
    paid_at:          tx.paid_at || null,
    channel:          tx.channel || null,
    customer_email:   tx.customer?.email || null,
    customer_name:    `${tx.customer?.first_name || ''} ${tx.customer?.last_name || ''}`.trim() || null,
    gateway_response: tx.gateway_response || null,
  };

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

  console.log('[webhook] ✓ booking persisted:', tx.reference);
}

// ── Increment discount.used in Supabase ────────────────────────
// Only fires when discount is currently enabled.
// Identical logic to verify-payment.js so both paths stay in sync.
async function incrementDiscountUsed() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[webhook] Supabase env vars not set — skipping discount increment');
    return;
  }

  // Read current discount settings
  const getRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount&select=value`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });

  if (!getRes.ok) {
    console.warn('[webhook] could not read discount settings:', getRes.status);
    return;
  }

  const rows     = await getRes.json();
  const discount = rows?.[0]?.value;

  if (!discount || !discount.enabled) {
    console.log('[webhook] discount not enabled — skipping increment');
    return;
  }

  const currentUsed = Number(discount.used) || 0;
  const newUsed     = currentUsed + 1;

  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.discount`, {
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

  if (!patchRes.ok) {
    const text = await patchRes.text();
    throw new Error(`Supabase PATCH failed: ${patchRes.status} ${text}`);
  }

  console.log(`[webhook] ✓ discount used: ${currentUsed} → ${newUsed} / ${discount.max_uses}`);

  if (newUsed >= discount.max_uses) {
    console.warn(`[webhook] ⚠ Discount limit reached (${newUsed}/${discount.max_uses})`);
  }
}