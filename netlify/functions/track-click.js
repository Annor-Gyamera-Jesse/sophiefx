/**
 * ============================================================
 * PIPS BUILT ACADEMY — track-click.js
 * Netlify Function: POST /.netlify/functions/track-click
 *
 * Proxies affiliate click tracking to Supabase using the
 * server-side service key. This keeps both the Supabase URL
 * and anon/service key off the browser entirely.
 *
 * Body: { "code": "AFFILIATECODE" }
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const code = (body.code || '').toUpperCase().trim();
  if (!code) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"code" is required' }) };
  }

  try {
    // Look up affiliate by code
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliates?code=eq.${encodeURIComponent(code)}&select=id,clicks&limit=1`,
      {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Accept':        'application/json',
        },
      }
    );

    if (!getRes.ok) throw new Error(`Supabase fetch failed: ${getRes.status}`);
    const rows = await getRes.json();

    if (!rows || !rows.length) {
      // Code not found — still return 200 so frontend doesn't error
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Affiliate not found' }) };
    }

    const aff = rows[0];

    // Increment click count
    await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${aff.id}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ clicks: (aff.clicks || 0) + 1 }),
    });

    console.log('[track-click] ✓ click tracked for', code);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error('[track-click]', err.message);
    // Non-fatal — return 200 so frontend flow isn't interrupted
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};