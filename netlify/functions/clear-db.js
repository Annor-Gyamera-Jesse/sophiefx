/**
 * ============================================================
 * SOPHIE FX — clear-db.js
 * Netlify Function: POST /.netlify/functions/clear-db
 *
 * Deletes ALL rows from the specified Supabase table.
 * Protected by MONITOR_SECRET — admin only.
 *
 * Body: { "table": "bookings" | "events" | "both" }
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

const ALLOWED_TABLES = ['bookings', 'events'];

async function clearTable(table) {
  // Supabase REST requires at least one filter to allow DELETE.
  // Both tables have a `created_at` TIMESTAMPTZ column — match everything
  // from before the Unix epoch onward (i.e. every row that has ever existed).
  // Using `not.is.null` on created_at is the most universally reliable filter.
  const filter = 'created_at=not.is.null';

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase DELETE on ${table} failed: ${res.status} ${text}`);
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

  // ── Auth check ──────────────────────────────────────────────
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Unauthorized' }),
    };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

  // ── Parse body ──────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Invalid JSON' }),
    };
  }

  const { table } = body;

  if (!table || !['bookings', 'events', 'both'].includes(table)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'table must be "bookings", "events", or "both"' }),
    };
  }

  const tables = table === 'both' ? ALLOWED_TABLES : [table];
  const results = {};

  for (const t of tables) {
    try {
      await clearTable(t);
      results[t] = 'cleared';
      console.log(`[clear-db] ✓ Cleared table: ${t}`);
    } catch (err) {
      results[t] = `error: ${err.message}`;
      console.error(`[clear-db] ✗ Failed to clear ${t}:`, err.message);
    }
  }

  const allOk = Object.values(results).every(v => v === 'cleared');

  return {
    statusCode: allOk ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: allOk,
      message: allOk
        ? `Successfully cleared: ${tables.join(', ')}`
        : `Some tables failed — check results`,
      results,
    }),
  };
};