/**
 * ============================================================
 * PIPS BUILT ACADEMY — update-settings.js
 * Netlify Function: POST /.netlify/functions/update-settings
 *
 * Admin-only endpoint (requires MONITOR_SECRET token).
 * Updates discount config and/or tier enabled flags in Supabase.
 *
 * Body examples:
 *   { "key": "discount", "value": { "enabled": true, "percent": 50, "max_uses": 50, "used": 0 } }
 *   { "key": "tiers",    "value": { "course": true, "group": false, "online": true, "onsite": true, "elite": true } }
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

async function upsertSetting(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
  return res.json();
}

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Auth check
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { key, value } = body;
  if (!key || !['discount', 'tiers'].includes(key)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'key must be "discount" or "tiers"' }) };
  }
  if (typeof value !== 'object' || value === null) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'value must be an object' }) };
  }

  try {
    await upsertSetting(key, value);
    console.log(`[update-settings] updated "${key}"`, JSON.stringify(value));
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, key, value }),
    };
  } catch (err) {
    console.error('[update-settings]', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: err.message }) };
  }
};