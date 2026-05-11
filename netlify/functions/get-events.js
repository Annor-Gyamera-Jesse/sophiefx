/**
 * ============================================================
 * SOPHIE FX — get-events.js
 * Netlify Function: GET /.netlify/functions/get-events
 *
 * Reads monitor events from Supabase for admin.html.
 * Protected by the same MONITOR_SECRET token.
 *
 * Query params:
 *   ?limit=200        — max events to return (default 200, max 500)
 *   ?since=1234567890 — only events with ts > this value
 *   ?level=error      — filter by level
 *   ?tag=paystack     — filter by tag
 *   ?search=foo       — search in msg
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

async function supabaseFetch(params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/events`);

  // Order by ts descending (newest first)
  url.searchParams.set('order', 'ts.desc');

  // Limit
  const limit = Math.min(parseInt(params.limit || '200', 10), 500);
  url.searchParams.set('limit', String(limit));

  // Since (for polling — only get new events)
  if (params.since) {
    url.searchParams.set('ts', `gt.${params.since}`);
  }

  // Level filter
  if (params.level && params.level !== 'all') {
    url.searchParams.set('level', `eq.${params.level}`);
  }

  // Tag filter
  if (params.tag) {
    url.searchParams.set('tag', `eq.${params.tag}`);
  }

  // Search in msg (Supabase ilike)
  if (params.search) {
    url.searchParams.set('msg', `ilike.*${params.search}*`);
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase fetch failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function supabaseCounts() {
  // Get counts per level in one query using Supabase's group-by via RPC
  // We'll do individual count queries — simple and reliable
  const levels = ['error', 'warn', 'success', 'info', 'payment', 'debug'];
  const counts = { all: 0 };

  // Get total count
  const totalRes = await fetch(`${SUPABASE_URL}/rest/v1/events?select=id`, {
    headers: {
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'count=exact',
      'Range':         '0-0',
    },
  });
  const contentRange = totalRes.headers.get('content-range');
  counts.all = contentRange ? parseInt(contentRange.split('/')[1], 10) || 0 : 0;

  return counts;
}

export const handler = async (event, context) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Method not allowed' }),
    };
  }

  // ── Secret token check ──────────────────────────────────────
  if (MONITOR_SECRET) {
    const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
    if (token !== MONITOR_SECRET) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Unauthorized' }),
      };
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const events = await supabaseFetch(params);

    // Reverse so oldest first for the admin log display
    events.reverse();

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, events, total: events.length }),
    };
  } catch (err) {
    console.error('[get-events] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};