/**
 * ============================================================
 * PIPS BUILT ACADEMY — reject-transfer.js
 * Netlify Function: POST /.netlify/functions/reject-transfer
 *
 * Admin-only. Called from admin.html when the admin clicks
 * "Reject" on a pending bank transfer. Marks the row as
 * rejected and stores an optional reason.
 *
 * The admin panel then sends a rejection email to the customer
 * via EmailJS on the frontend.
 *
 * Body: { "id": "<pending_transfer uuid>", "reason": "..." }
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

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Monitor-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

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

  const { id, reason } = body;
  if (!id) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: '"id" is required' }) };

  try {
    // Fetch first so we can return customer details to the frontend for the email
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_transfers?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Accept': 'application/json' },
    });

    if (!getRes.ok) throw new Error(`Supabase fetch failed: ${getRes.status}`);
    const rows = await getRes.json();
    const transfer = rows?.[0];
    if (!transfer) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Transfer not found' }) };

    if (transfer.status === 'approved') {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Cannot reject an already approved transfer' }) };
    }

    // Mark as rejected
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/pending_transfers?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        status:           'rejected',
        rejection_reason: reason || 'No reason provided',
        reviewed_at:      new Date().toISOString(),
      }),
    });

    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(`Supabase PATCH failed: ${patchRes.status} ${text}`);
    }

    console.log('[reject-transfer] ✓ rejected:', transfer.booking_ref, '| reason:', reason || '(none)');

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message:          'Transfer rejected.',
        booking_ref:      transfer.booking_ref,
        customer_email:   transfer.customer_email,
        customer_name:    transfer.customer_name,
        rejection_reason: reason || 'No reason provided',
      }),
    };
  } catch (err) {
    console.error('[reject-transfer]', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};
