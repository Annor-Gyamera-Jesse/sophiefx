/**
 * ============================================================
 * PIPS BUILT ACADEMY — submit-bank-transfer.js
 * Netlify Function: POST /.netlify/functions/submit-bank-transfer
 *
 * Called by index.html when a customer clicks "I've Made the
 * Transfer — Confirm Booking" on the Manual Wire payment method.
 *
 * What this does:
 *   1. Validates the booking payload
 *   2. Optionally uploads the payment receipt to Supabase Storage
 *   3. Inserts a row into the `pending_transfers` table (status = 'pending')
 *   4. Notifies the admin via EmailJS (server can't, so front-end handles
 *      the customer email — this function just persists the data)
 *
 * The admin then reviews in admin.html and clicks Approve.
 * Approval runs approve-transfer.js which promotes the booking
 * into the main `bookings` table and unlocks the WhatsApp join link.
 *
 * Supabase table — run this SQL once:
 *
 *   CREATE TABLE IF NOT EXISTS pending_transfers (
 *     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     booking_ref      TEXT NOT NULL UNIQUE,
 *     tier             TEXT,
 *     amount_ghs       NUMERIC,
 *     amount_usd       NUMERIC,
 *     customer_name    TEXT,
 *     customer_email   TEXT,
 *     customer_phone   TEXT,
 *     customer_country TEXT,
 *     customer_whatsapp TEXT,
 *     experience       TEXT,
 *     start_date       TEXT,
 *     source           TEXT,
 *     message          TEXT,
 *     affiliate_code   TEXT,
 *     receipt_url      TEXT,
 *     status           TEXT NOT NULL DEFAULT 'pending',
 *     rejection_reason TEXT,
 *     reviewed_by      TEXT,
 *     reviewed_at      TIMESTAMPTZ,
 *     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 *   -- Index for fast admin fetch of pending rows
 *   CREATE INDEX IF NOT EXISTS idx_pending_transfers_status ON pending_transfers(status);
 *
 * Supabase Storage bucket — run this SQL once:
 *
 *   INSERT INTO storage.buckets (id, name, public)
 *   VALUES ('transfer-receipts', 'transfer-receipts', false)
 *   ON CONFLICT (id) DO NOTHING;
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RECEIPT_BUCKET       = 'transfer-receipts';

// ── Supabase REST helper ─────────────────────────────────────
async function sb(path, method = 'GET', body = null, extraHeaders = {}) {
  const opts = {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
      ...extraHeaders,
    },
  };
  if (body !== null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  }
  return res;
}

// ── Upload receipt to Supabase Storage ──────────────────────
// base64Data is the raw base64 string (no data: prefix).
// Returns the public URL or null on failure.
async function uploadReceipt(bookingRef, base64Data, mimeType) {
  if (!base64Data || !mimeType) return null;

  // Validate size — max 5 MB receipt
  const bytes = Math.ceil((base64Data.length * 3) / 4);
  if (bytes > 5 * 1024 * 1024) {
    console.warn('[submit-bank-transfer] Receipt too large — skipping upload');
    return null;
  }

  // Convert base64 → binary buffer
  const binary   = Buffer.from(base64Data, 'base64');
  const ext      = mimeType.split('/')[1] || 'jpg';
  const filename = `${bookingRef}.${ext}`;

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${RECEIPT_BUCKET}/${filename}`,
    {
      method:  'POST',
      headers: {
        'apikey':         SUPABASE_SERVICE_KEY,
        'Authorization':  `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':   mimeType,
        'x-upsert':       'true',
      },
      body: binary,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('[submit-bank-transfer] Storage upload failed:', res.status, text);
    return null;
  }

  // Build the signed URL (valid 7 days) so admin can preview without making bucket public
  const signRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${RECEIPT_BUCKET}/${filename}`,
    {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ expiresIn: 7 * 24 * 60 * 60 }), // 7 days
    }
  );

  if (!signRes.ok) {
    console.warn('[submit-bank-transfer] Could not sign receipt URL — storing path only');
    return filename;
  }

  const signData = await signRes.json();
  return signData?.signedURL
    ? `${SUPABASE_URL}/storage/v1${signData.signedURL}`
    : filename;
}

// ── Handler ──────────────────────────────────────────────────
export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  // ── Parse body ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const {
    booking_ref,
    tier,
    amount_ghs,
    amount_usd,
    customer_name,
    customer_email,
    customer_phone,
    customer_country,
    customer_whatsapp,
    experience,
    start_date,
    source,
    message,
    affiliate_code,
    // Optional receipt upload — { data: '<base64>', mimeType: 'image/jpeg' }
    receipt,
  } = body;

  // ── Required field validation ──────────────────────────────
  if (!booking_ref || !customer_email || !customer_name || !tier) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'booking_ref, customer_email, customer_name, and tier are required' }),
    };
  }

  // Basic booking_ref format check — same pattern as join-channel.js
  if (!/^(SA|BK)-[A-Z0-9]{4,12}(-[A-Z0-9]{1,6})?$/i.test(booking_ref)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Invalid booking reference format' }),
    };
  }

  // ── Upload receipt if provided ─────────────────────────────
  let receipt_url = null;
  if (receipt?.data && receipt?.mimeType) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(receipt.mimeType)) {
      receipt_url = await uploadReceipt(booking_ref, receipt.data, receipt.mimeType);
    } else {
      console.warn('[submit-bank-transfer] Unsupported receipt MIME type:', receipt.mimeType);
    }
  }

  // ── Insert into pending_transfers ─────────────────────────
  const row = {
    booking_ref,
    tier,
    amount_ghs:       amount_ghs    || null,
    amount_usd:       amount_usd    || null,
    customer_name,
    customer_email,
    customer_phone:   customer_phone   || null,
    customer_country: customer_country || null,
    customer_whatsapp: customer_whatsapp || null,
    experience:       experience    || null,
    start_date:       start_date    || null,
    source:           source        || null,
    message:          message       || null,
    affiliate_code:   affiliate_code || null,
    receipt_url,
    status: 'pending',
  };

  try {
    // resolution=ignore-duplicates so resubmitting same booking_ref is safe
    await sb('pending_transfers', 'POST', row, { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
    console.log('[submit-bank-transfer] ✓ pending transfer saved:', booking_ref);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Transfer submission received. The team will verify within 24 hours.',
        booking_ref,
      }),
    };
  } catch (err) {
    console.error('[submit-bank-transfer] Supabase error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Could not save your submission. Please try again or contact the team.' }),
    };
  }
};
