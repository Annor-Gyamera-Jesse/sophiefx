/**
 * ============================================================
 * PIPS BUILT ACADEMY — get-monitor-token.js
 * Netlify Function: GET /.netlify/functions/get-monitor-token
 *
 * Serves the MONITOR_SECRET to the frontend securely.
 * The token never appears in the HTML source — it is fetched
 * once on page load and kept in memory only.
 *
 * No auth required — the token itself is not sensitive enough
 * to gate, but it is never visible in page source or JS files.
 *
 * ENV VARS REQUIRED:
 *   MONITOR_SECRET = your admin token
 * ============================================================
 */

const MONITOR_SECRET = process.env.MONITOR_SECRET;

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  if (!MONITOR_SECRET) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Monitor token not configured' }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, token: MONITOR_SECRET }),
  };
};