/**
 * ============================================================
 * PIPS BUILT ACADEMY — affiliate-admin.js
 * Netlify Function: POST /.netlify/functions/affiliate-admin
 *
 * Proxies admin write operations to Supabase using the server-side
 * SUPABASE_SERVICE_KEY. This keeps the service_role key off the
 * browser entirely — affiliate.html calls this function instead.
 *
 * Protected by MONITOR_SECRET (same token as other admin endpoints).
 *
 * Body: { "action": "...", ...params }
 *
 * Actions:
 *   approve       — { id }
 *   suspend       — { id, newStatus }
 *   markPaid      — { affiliateId, code, amount }
 *   confirmPayout — { id }
 *   updateComm    — { id, comm_rate }
 *   reject        — { id }
 *   patchAffiliate — { id, fields: {...} }   (generic patch)
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your admin token
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

// ── Supabase helper ───────────────────────────────────────────
async function sb(path, method = 'GET', body = null, prefer = 'return=representation') {
  const opts = {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        prefer,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  if (res.status === 204 || method === 'DELETE') return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

// ── Handler ───────────────────────────────────────────────────
export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────
  const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
  if (!MONITOR_SECRET || token !== MONITOR_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  // ── Parse body ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { action } = body;
  if (!action) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"action" is required' }) };
  }

  try {
    let result = null;

    if (action === 'approve') {
      // Set status to approved
      const { id } = body;
      if (!id) throw new Error('"id" required');
      result = await sb(`affiliates?id=eq.${encodeURIComponent(id)}`, 'PATCH', { status: 'approved' });
      result = Array.isArray(result) ? result[0] : result;

    } else if (action === 'suspend') {
      // Toggle suspend/unsuspend
      const { id, newStatus } = body;
      if (!id || !newStatus) throw new Error('"id" and "newStatus" required');
      if (!['approved', 'suspended', 'rejected'].includes(newStatus)) throw new Error('Invalid newStatus');
      result = await sb(`affiliates?id=eq.${encodeURIComponent(id)}`, 'PATCH', { status: newStatus });
      result = Array.isArray(result) ? result[0] : result;

    } else if (action === 'reject') {
      const { id } = body;
      if (!id) throw new Error('"id" required');
      result = await sb(`affiliates?id=eq.${encodeURIComponent(id)}`, 'PATCH', { status: 'rejected' });
      result = Array.isArray(result) ? result[0] : result;

    } else if (action === 'markPaid') {
      // Insert payout record + update affiliate paid_ghs
      const { affiliateId, code, amount } = body;
      if (!affiliateId || !code || amount == null) throw new Error('"affiliateId", "code", "amount" required');

      // Insert payout
      await sb('affiliate_payouts', 'POST', {
        affiliate_id: affiliateId,
        affiliate_code: code,
        amount_ghs: amount,
        status: 'paid',
        method: 'Manual',
      }, 'return=minimal');

      // Read current paid_ghs
      const rows = await sb(`affiliates?id=eq.${encodeURIComponent(affiliateId)}&select=*`);
      const aff = Array.isArray(rows) ? rows[0] : rows;
      const prev = aff?.paid_ghs || 0;

      // Update paid_ghs
      await sb(`affiliates?id=eq.${encodeURIComponent(affiliateId)}`, 'PATCH', { paid_ghs: prev + amount }, 'return=minimal');

      result = aff; // return affiliate row so frontend can send confirmation email

    } else if (action === 'confirmPayout') {
      const { id } = body;
      if (!id) throw new Error('"id" required');
      await sb(`affiliate_payouts?id=eq.${encodeURIComponent(id)}`, 'PATCH', { status: 'paid' }, 'return=minimal');
      result = { id };

    } else if (action === 'patchAffiliate') {
      // Generic patch — only allow safe field names
      const { id, fields } = body;
      if (!id || !fields || typeof fields !== 'object') throw new Error('"id" and "fields" object required');
      const ALLOWED_FIELDS = ['status', 'comm_rate', 'paid_ghs', 'notes', 'payout_info', 'name', 'phone', 'platform', 'social'];
      const safe = {};
      for (const [k, v] of Object.entries(fields)) {
        if (ALLOWED_FIELDS.includes(k)) safe[k] = v;
      }
      if (!Object.keys(safe).length) throw new Error('No allowed fields in "fields"');
      result = await sb(`affiliates?id=eq.${encodeURIComponent(id)}`, 'PATCH', safe);
      result = Array.isArray(result) ? result[0] : result;

    } else {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: `Unknown action: ${action}` }) };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, data: result }),
    };

  } catch (err) {
    console.error('[affiliate-admin]', action, err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};