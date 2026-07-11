/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-delete.js
 * Netlify Function: POST /.netlify/functions/journal-delete
 *
 * Deletes a single journal_trades row.
 * Ownership check: the row's student_id must match the
 * session header — students can only delete their own trades.
 *
 * Body: { "id": "<uuid>", "student_id": "<hex>" }
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Journal-Session',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  const sessionId = event.headers['x-journal-session'];
  if (!sessionId || sessionId.length < 16) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { id, student_id } = body;
  if (!id || !student_id || student_id !== sessionId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid request or session mismatch' }) };
  }

  try {
    // Include student_id in the filter — prevents deleting another student's trade
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
