/**
 * ============================================================
 * PIPS BUILT ACADEMY — get-pending-transfers.js
 * Netlify Function: GET /.netlify/functions/get-pending-transfers
 *
 * Admin-only endpoint. Returns all rows from pending_transfers,
 * optionally filtered by status.
 *
 * Query params:
 *   ?status=pending   — filter by status (default: all)
 *   ?limit=100        — max rows (default 100)
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

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  // ── Auth ──────────────────────────────────────────────────────
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const limit  = Math.min(parseInt(params.limit || '100', 10), 500);

    const url = new URL(`${SUPABASE_URL}/rest/v1/pending_transfers`);
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', String(limit));

    // Optional status filter — 'pending' | 'approved' | 'rejected' | (omit for all)
    if (params.status && ['pending', 'approved', 'rejected'].includes(params.status)) {
      url.searchParams.set('status', `eq.${params.status}`);
    }

    const res = await fetch(url.toString(), {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept':        'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase fetch failed: ${res.status} ${text}`);
    }

    const transfers = await res.json();

    // Count by status for admin badges
    const counts = { pending: 0, approved: 0, rejected: 0 };
    transfers.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, transfers, counts }),
    };
  } catch (err) {
    console.error('[get-pending-transfers]', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};
