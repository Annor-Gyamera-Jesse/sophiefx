/**
 * ============================================================
 * PIPS BUILT ACADEMY — approve-transfer.js
 * Netlify Function: POST /.netlify/functions/approve-transfer
 *
 * Admin-only. Called from admin.html when the admin clicks
 * "Approve" on a pending bank transfer.
 *
 * What this does:
 *   1. Marks the pending_transfers row as 'approved'
 *   2. Inserts the booking into the main `bookings` table
 *      (same table, same schema as Paystack bookings — so the
 *       join-channel.js gate works identically for both paths)
 *   3. Increments the discount used count (same as verify-payment.js)
 *   4. Runs affiliate attribution if applicable
 *
 * After this runs, the customer's WhatsApp join link activates.
 * The frontend admin sends them a confirmation email via EmailJS.
 *
 * Body: { "id": "<pending_transfer uuid>" }
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your admin token
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

// ── Supabase helper ───────────────────────────────────────────
async function sb(path, method = 'GET', body = null, prefer = 'return=representation') {
  const opts = {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        prefer,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

// ── Increment discount used — same logic as verify-payment.js ─
async function incrementDiscountUsed() {
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
  console.log(`[approve-transfer] discount used: ${discount.used} → ${newUsed}`);
}

// ── Affiliate attribution — same logic as verify-payment.js ───
async function attributeAffiliate(bookingRef, amountGhs, affiliateCode) {
  if (!affiliateCode || !bookingRef) return;

  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/affiliates?code=eq.${encodeURIComponent(affiliateCode)}&status=eq.approved&select=id,bookings,earned_ghs,comm_rate&limit=1`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Accept': 'application/json' } }
  );
  if (!getRes.ok) return;

  const rows = await getRes.json();
  if (!rows?.length) return;

  const aff        = rows[0];
  const rate       = (aff.comm_rate || 30) / 100;
  const commission = Math.round((amountGhs || 0) * rate);

  await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${aff.id}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ bookings: (aff.bookings || 0) + 1, earned_ghs: (aff.earned_ghs || 0) + commission }),
  });

  await fetch(`${SUPABASE_URL}/rest/v1/bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ affiliate_code: affiliateCode }),
  });

  console.log(`[approve-transfer] ✓ affiliate ${affiliateCode} earns GH₵${commission} for booking ${bookingRef}`);
}

// ── Handler ───────────────────────────────────────────────────
export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  // ── Auth ──────────────────────────────────────────────────────
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { id } = body;
  if (!id) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"id" (pending_transfer uuid) is required' }) };

  try {
    // ── 1. Fetch the pending transfer row ─────────────────────
    const rows = await sb(`pending_transfers?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    const transfer = Array.isArray(rows) ? rows[0] : rows;

    if (!transfer) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Transfer not found' }) };
    }

    if (transfer.status === 'approved') {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, message: 'Already approved', transfer }) };
    }

    if (transfer.status === 'rejected') {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Cannot approve a rejected transfer — create a new booking instead' }) };
    }

    // ── 2. Insert into main bookings table ────────────────────
    // We generate a synthetic "reference" that is clearly identifiable
    // as a manual bank transfer and matches the booking_ref format.
    const syntheticRef = `BANK-${transfer.booking_ref}`;

    // amount stored in pesewas (× 100) to match Paystack convention
    const amountPesewas = Math.round((transfer.amount_ghs || 0) * 100);

    const bookingRow = {
      reference:        syntheticRef,
      booking_ref:      transfer.booking_ref,
      tier:             transfer.tier,
      amount:           amountPesewas,
      currency:         'GHS',
      paid_at:          new Date().toISOString(),
      channel:          'bank_transfer_manual',
      customer_email:   transfer.customer_email,
      customer_name:    transfer.customer_name,
      customer_phone:   transfer.customer_phone,
      customer_country: transfer.customer_country,
      customer_whatsapp: transfer.customer_whatsapp,
      gateway_response: 'Manual bank transfer — approved by admin',
      affiliate_code:   transfer.affiliate_code || null,
    };

    // merge-duplicates means re-approving the same transfer is safe
    await sb('bookings', 'POST', bookingRow, 'resolution=merge-duplicates,return=minimal');
    console.log('[approve-transfer] ✓ booking inserted:', syntheticRef);

    // ── 3. Mark the pending_transfers row as approved ─────────
    await sb(
      `pending_transfers?id=eq.${encodeURIComponent(id)}`,
      'PATCH',
      { status: 'approved', reviewed_at: new Date().toISOString() },
      'return=minimal'
    );

    // ── 4. Side-effects (non-fatal) ───────────────────────────
    await Promise.allSettled([
      incrementDiscountUsed(),
      attributeAffiliate(transfer.booking_ref, transfer.amount_ghs || 0, transfer.affiliate_code),
    ]);

    console.log('[approve-transfer] ✓ fully approved:', transfer.booking_ref);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message:     'Transfer approved. WhatsApp join link is now active for this booking.',
        booking_ref: transfer.booking_ref,
        customer_email: transfer.customer_email,
        customer_name:  transfer.customer_name,
        tier:           transfer.tier,
        amount_ghs:     transfer.amount_ghs,
        // Frontend uses this to build the join link URL for the email
        join_link: `/.netlify/functions/join-channel?ref=${encodeURIComponent(transfer.booking_ref)}`,
      }),
    };

  } catch (err) {
    console.error('[approve-transfer] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};
