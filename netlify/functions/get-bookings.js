/**
 * ============================================================
 * SOPHIE FX — get-bookings.js
 * Netlify Function: GET /.netlify/functions/get-bookings
 *
 * Reads bookings from Supabase for admin.html.
 * Protected by MONITOR_SECRET token.
 *
 * Query params:
 *   ?limit=100        — max bookings to return (default 100)
 *   ?search=foo       — search in reference, email, name
 *   ?tier=online      — filter by tier
 *   ?channel=card     — filter by channel
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

async function fetchBookings(params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/bookings`);

  url.searchParams.set('order', 'created_at.desc');

  const limit = Math.min(parseInt(params.limit || '100', 10), 500);
  url.searchParams.set('limit', String(limit));

  if (params.tier && params.tier !== 'all') {
    url.searchParams.set('tier', `eq.${params.tier}`);
  }

  if (params.channel && params.channel !== 'all') {
    url.searchParams.set('channel', `eq.${params.channel}`);
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

  const rows = await res.json();

  // Client-side search filter (Supabase ilike on multiple cols needs OR)
  if (params.search) {
    const q = params.search.toLowerCase();
    return rows.filter(b =>
      (b.reference     || '').toLowerCase().includes(q) ||
      (b.booking_ref   || '').toLowerCase().includes(q) ||
      (b.customer_email|| '').toLowerCase().includes(q) ||
      (b.customer_name || '').toLowerCase().includes(q)
    );
  }

  return rows;
}

async function fetchBookingStats() {
  // Total count
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/bookings?select=amount,tier,channel`, {
    headers: {
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });

  if (!countRes.ok) return null;

  const rows = await countRes.json();
  const total        = rows.length;
  const totalRevenue = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const onlineCount  = rows.filter(r => r.tier === 'online').length;
  const onsiteCount  = rows.filter(r => r.tier === 'onsite').length;
  const cardCount    = rows.filter(r => r.channel === 'card').length;
  const momoCount    = rows.filter(r => r.channel === 'mobile_money').length;

  return { total, totalRevenue, onlineCount, onsiteCount, cardCount, momoCount };
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
    const params   = event.queryStringParameters || {};
    const [bookings, stats] = await Promise.all([
      fetchBookings(params),
      fetchBookingStats(),
    ]);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, bookings, stats }),
    };
  } catch (err) {
    console.error('[get-bookings] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};