/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-delete.js
 * Netlify Function: POST /.netlify/functions/journal-delete
 *
 * Deletes a single journal_trades row.
 * Ownership check: the row's student_id must match the student_id
 * resolved server-side from the X-Journal-Session token — never a
 * student_id supplied by the client. See JOURNAL_SESSIONS_MIGRATION.sql.
 *
 * Body: { "id": "<uuid>" }
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

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Journal-Session',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

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
    console.error('[journal-delete] session lookup error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session check failed. Try again.' }) };
  }
  if (!student_id) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session expired or invalid. Please log in again.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { id } = body;
  if (!id) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"id" is required' }) };
  }

  try {
    // student_id comes from the resolved session, not the client —
    // this can only ever delete a row that belongs to the caller.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/journal_trades?id=eq.${encodeURIComponent(id)}&student_id=eq.${encodeURIComponent(student_id)}`,
      {
        method: 'DELETE',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer':        'return=minimal',
        },
      }
    );

    if (!res.ok) throw new Error(`Supabase DELETE failed: ${res.status}`);
    console.log('[journal-delete] ✓ deleted trade:', id, 'student:', student_id.slice(0,8) + '…');

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Trade deleted.' }),
    };
  } catch (err) {
    console.error('[journal-delete]', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: err.message }) };
  }
};