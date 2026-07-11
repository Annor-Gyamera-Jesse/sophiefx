/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-fetch.js
 * Netlify Function: GET /.netlify/functions/journal-fetch
 *
 * Returns all journal_trades for a given student_id.
 * Protected by X-Journal-Session header which must match
 * the student_id query param.
 *
 * Query params:
 *   ?student_id=<hex>   — the student's session ID
 *   ?limit=500          — max trades (default 500)
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Journal-Session',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  // ── Session check ──────────────────────────────────────────
  const sessionId   = event.headers['x-journal-session'];
  const params      = event.queryStringParameters || {};
  const student_id  = params.student_id;

  if (!sessionId || !student_id || sessionId !== student_id || sessionId.length < 16) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  try {
    const limit = Math.min(parseInt(params.limit || '500', 10), 1000);
    const url   = new URL(`${SUPABASE_URL}/rest/v1/journal_trades`);
    url.searchParams.set('student_id', `eq.${student_id}`);
    url.searchParams.set('order', 'trade_date.desc');
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url.toString(), {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept':        'application/json',
      },
    });

    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const trades = await res.json();

    console.log('[journal-fetch] returned', trades.length, 'trades for student', student_id.slice(0,8) + '…');
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, trades, count: trades.length }),
    };
  } catch (err) {
    console.error('[journal-fetch]', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: err.message }) };
  }
};
