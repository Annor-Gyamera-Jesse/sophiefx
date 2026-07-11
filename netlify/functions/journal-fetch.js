/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-fetch.js
 * Netlify Function: GET /.netlify/functions/journal-fetch
 *
 * Returns all journal_trades belonging to the student behind the
 * given session token. The token is resolved server-side against
 * the journal_sessions table (see JOURNAL_SESSIONS_MIGRATION.sql) —
 * the client can no longer just declare a student_id and have it
 * trusted, which was the original isolation bug.
 *
 * Header required:
 *   X-Journal-Session: <session token returned by journal-auth>
 *
 * Query params:
 *   ?limit=500          — max trades (default 500)
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function resolveSession(token) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/journal_sessions?token=eq.${encodeURIComponent(token)}&select=student_id,expires_at&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept':        'application/json',
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase session lookup failed: ${res.status}`);
  const rows = await res.json();
  const row  = rows?.[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.student_id;
}

// Best-effort — don't block the response on this.
function touchSession(token) {
  fetch(`${SUPABASE_URL}/rest/v1/journal_sessions?token=eq.${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});
}

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

  // ── Session check — the token is the only source of identity ──
  const token = event.headers['x-journal-session'];
  if (!token || token.length < 32) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  let student_id;
  try {
    student_id = await resolveSession(token);
  } catch (err) {
    console.error('[journal-fetch] session lookup error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session check failed. Try again.' }) };
  }

  if (!student_id) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session expired or invalid. Please log in again.' }) };
  }

  touchSession(token);

  try {
    const params = event.queryStringParameters || {};
    const limit  = Math.min(parseInt(params.limit || '500', 10), 1000);
    const url    = new URL(`${SUPABASE_URL}/rest/v1/journal_trades`);
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
    const tradesRows = await res.json();

    console.log('[journal-fetch] returned', tradesRows.length, 'trades for student', student_id.slice(0,8) + '…');
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, trades: tradesRows, count: tradesRows.length }),
    };
  } catch (err) {
    console.error('[journal-fetch]', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: err.message }) };
  }
};