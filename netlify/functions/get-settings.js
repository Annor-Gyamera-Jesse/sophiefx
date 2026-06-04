/**
 * ============================================================
 * PIPS BUILT ACADEMY — get-settings.js
 * Netlify Function: GET /.netlify/functions/get-settings
 *
 * Returns the current discount + tier-enabled settings from
 * Supabase `settings` table. Called by index.html on load
 * (public, no auth) and by admin.html (with monitor token).
 *
 * Supabase table (run this SQL once in Supabase SQL editor):
 *
 *   CREATE TABLE IF NOT EXISTS settings (
 *     key   TEXT PRIMARY KEY,
 *     value JSONB NOT NULL,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 *   -- seed defaults
 *   INSERT INTO settings (key, value) VALUES
 *     ('discount', '{"enabled":false,"percent":50,"max_uses":50,"used":0}'::jsonb),
 *     ('tiers',    '{"course":true,"group":true,"online":true,"onsite":true,"elite":true}'::jsonb)
 *   ON CONFLICT (key) DO NOTHING;
 *
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function fetchSettings() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=key,value`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept':        'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  const rows = await res.json();
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return out;
}

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  try {
    const settings = await fetchSettings();

    // Defaults if table rows don't exist yet
    const discount = settings.discount || { enabled: false, percent: 50, max_uses: 50, used: 0 };
    const tiers    = settings.tiers    || { course: true, group: true, online: true, onsite: true, elite: true };

    // For the public-facing index.html we strip used count if no auth token
    const MONITOR_SECRET = process.env.MONITOR_SECRET;
    const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
    const isAdmin = MONITOR_SECRET && token === MONITOR_SECRET;

    const publicDiscount = {
      enabled:   discount.enabled,
      percent:   discount.percent,
      max_uses:  discount.max_uses,
      used:      isAdmin ? discount.used : undefined,
      // remaining spots shown to the public
      spots_left: discount.enabled ? Math.max(0, discount.max_uses - (discount.used || 0)) : null,
      active:    discount.enabled && (discount.used || 0) < discount.max_uses,
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, discount: publicDiscount, tiers }),
    };
  } catch (err) {
    console.error('[get-settings]', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: err.message }) };
  }
};