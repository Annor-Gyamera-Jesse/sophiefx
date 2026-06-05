/**
 * ============================================================
 * SOPHIE FX — import-bookings.js
 * Netlify Function: POST /.netlify/functions/import-bookings
 *
 * Accepts an array of booking objects (from a prior export)
 * and upserts them into Supabase. On conflict (same reference),
 * it updates all fields — so a re-import is always safe.
 *
 * Body: { "bookings": [ ...rowsFromExport ] }
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

const ALLOWED_COLS = [
  'reference', 'booking_ref', 'tier', 'amount', 'currency',
  'paid_at', 'channel', 'customer_email', 'customer_name',
  'gateway_response', 'created_at',
];

function sanitizeRow(raw) {
  const row = {};
  for (const col of ALLOWED_COLS) {
    if (raw[col] !== undefined && raw[col] !== null && raw[col] !== '') {
      row[col] = raw[col];
    }
  }
  // amount_ghs is the human-readable export column — convert back to integer pesewas
  if (!row.amount && raw.amount_ghs) {
    row.amount = Math.round(parseFloat(raw.amount_ghs) * 100);
  }
  return row;
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
  return true;
}

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // ── Auth ────────────────────────────────────────────────────
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  // ── Parse body ──────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const rawRows = body.bookings;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"bookings" array is required and must not be empty' }) };
  }

  if (rawRows.length > 1000) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Max 1000 rows per import' }) };
  }

  // ── Sanitize rows ───────────────────────────────────────────
  const rows = rawRows.map(sanitizeRow).filter(r => r.reference && r.amount && r.currency);
  const skipped = rawRows.length - rows.length;

  if (rows.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'No valid rows found — each row needs at least reference, amount, currency' }) };
  }

  // ── Upsert in batches of 100 ────────────────────────────────
  const BATCH_SIZE = 100;
  let imported = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await upsertBatch(batch);
      imported += batch.length;
    } catch (err) {
      errors.push(`Batch ${Math.floor(i/BATCH_SIZE)+1}: ${err.message}`);
      console.error('[import-bookings] batch error:', err.message);
    }
  }

  console.log(`[import-bookings] imported=${imported} skipped=${skipped} errors=${errors.length}`);

  return {
    statusCode: errors.length && imported === 0 ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: errors.length === 0,
      imported,
      skipped,
      errors: errors.length ? errors : undefined,
      message: errors.length === 0
        ? `Successfully imported ${imported} bookings`
        : `Imported ${imported}, ${errors.length} batch(es) failed`,
    }),
  };
};