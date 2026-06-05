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

import crypto from 'crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

  if (!PAYSTACK_SECRET) {
    console.error('[webhook] PAYSTACK_SECRET_KEY not set');
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  // Verify Paystack signature -- reject anything that doesn't match
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
    console.warn('[webhook] Signature mismatch -- possible spoofed request');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // Parse event
  let evt;
  try {
    evt = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // ALWAYS return 200 immediately -- Paystack retries on non-2xx
  if (evt.event === 'charge.success') {
    const tx = evt.data;
    console.log('[webhook] charge.success --', tx.reference, tx.amount, tx.currency);

    // Run side effects async -- don't block the 200 response
    (async () => {
      try {
        // KEY GUARD: check if verify-payment.js already handled this payment.
        // If the booking already exists in Supabase, verify-payment.js got there
        // first and already incremented the discount count -- so we only upsert
        // the booking (safe, idempotent) and skip the increment to avoid double-counting.
        const alreadySaved = await bookingExists(tx.reference);

        await persistBooking(tx);

        if (alreadySaved) {
          console.log('[webhook] booking already saved by verify-payment -- skipping discount increment for', tx.reference);
        } else {
          // verify-payment.js never ran (user closed browser, network drop, etc.)
          // This is the webhook's job -- save the booking AND increment the count
          console.log('[webhook] new booking via webhook -- incrementing discount for', tx.reference);
          await incrementDiscountUsed();
        }

        console.log('[webhook] done for', tx.reference);
      } catch (err) {
        console.error('[webhook] side-effect error:', err.message);
      }
    })();

  } else {
    console.log('[webhook] unhandled event type:', evt.event);
  }

  return { statusCode: 200, body: 'OK' };
};

// Check if this reference already exists in the bookings table.
// Used to detect whether verify-payment.js already handled this payment.
async function bookingExists(reference) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bookings?reference=eq.${encodeURIComponent(reference)}&select=reference&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept':        'application/json',
      },
    }
  );

  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

// Upsert booking into Supabase.
// ON CONFLICT (same reference) just updates the row -- always safe to call.
async function persistBooking(tx) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[webhook] Supabase env vars not set -- skipping persist');
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

  console.log('[webhook] booking persisted:', tx.reference);
}

// Atomically increment discount.used by 1.
// Only runs when discount is currently enabled.
async function incrementDiscountUsed() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[webhook] Supabase env vars not set -- skipping discount increment');
    return;
  }

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
    console.log('[webhook] discount not enabled -- skipping increment');
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

  console.log(`[webhook] discount used: ${currentUsed} -> ${newUsed} / ${discount.max_uses}`);

  if (newUsed >= discount.max_uses) {
    console.warn(`[webhook] Discount limit reached (${newUsed}/${discount.max_uses})`);
  }
}