/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-save.js
 * Netlify Function: POST /.netlify/functions/journal-save
 *
 * Saves (or updates) a trade entry in the journal_trades table.
 * The student_id used for storage and ownership checks is resolved
 * server-side from the X-Journal-Session token — it is never taken
 * from the request body. See JOURNAL_SESSIONS_MIGRATION.sql.
 *
 * If a screenshot is provided, uploads it to Supabase Storage
 * (journal-screenshots bucket) and stores the signed URL.
 *
 * Supabase table — see JOURNAL_SETUP.sql for journal_trades and
 * JOURNAL_SESSIONS_MIGRATION.sql for journal_sessions.
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SCREENSHOT_BUCKET    = 'journal-screenshots';

// ── Session resolution ────────────────────────────────────
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

// ── Screenshot upload ─────────────────────────────────────
async function uploadScreenshot(studentId, tradeId, base64Data, mimeType) {
  if (!base64Data || !mimeType) return null;

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(mimeType)) return null;

  const bytes = Math.ceil((base64Data.length * 3) / 4);
  if (bytes > 5 * 1024 * 1024) {
    console.warn('[journal-save] Screenshot too large — skipping');
    return null;
  }

  const binary   = Buffer.from(base64Data, 'base64');
  const ext      = mimeType.split('/')[1] || 'jpg';
  const filename = `${studentId}/${tradeId}.${ext}`;

  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${SCREENSHOT_BUCKET}/${filename}`,
    {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  mimeType,
        'x-upsert':      'true',
      },
      body: binary,
    }
  );

  if (!uploadRes.ok) {
    console.error('[journal-save] Storage upload failed:', await uploadRes.text());
    return null;
  }

  // Generate a 1-year signed URL (students always see their own screenshots)
  const signRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${SCREENSHOT_BUCKET}/${filename}`,
    {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ expiresIn: 365 * 24 * 60 * 60 }), // 1 year
    }
  );

  if (!signRes.ok) return filename; // fallback to path if signing fails

  const signData = await signRes.json();
  return signData?.signedURL
    ? `${SUPABASE_URL}/storage/v1${signData.signedURL}`
    : filename;
}

// ── Handler ────────────────────────────────────────────────
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
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'No valid session' }) };
  }

  let student_id;
  try {
    student_id = await resolveSession(token);
  } catch (err) {
    console.error('[journal-save] session lookup error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session check failed. Try again.' }) };
  }
  if (!student_id) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Session expired or invalid. Please log in again.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  // NOTE: student_id is intentionally NOT read from the body anymore —
  // it comes only from the resolved session above. If the client sends
  // one, it's ignored.
  const { pair, direction, result, screenshot, edit_id, ...rest } = body;

  if (!pair || !direction || !result) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'pair, direction, and result are required' }) };
  }

  try {
    const { v4: uuidv4 } = await import('crypto').then(m => ({
      v4: () => m.randomUUID()
    }));
    const tradeId = edit_id || uuidv4();

    // Upload screenshot if provided
    let screenshot_url = null;
    if (screenshot?.data && screenshot?.mimeType) {
      screenshot_url = await uploadScreenshot(student_id, tradeId, screenshot.data, screenshot.mimeType);
    }

    const row = {
      student_id,
      pair:            pair.toUpperCase(),
      direction,
      session:         rest.session         || null,
      trade_date:      rest.trade_date       || new Date().toISOString(),
      entry_price:     rest.entry_price      || null,
      exit_price:      rest.exit_price       || null,
      sl:              rest.sl               || null,
      tp:              rest.tp               || null,
      lots:            rest.lots             || null,
      pnl_usd:         rest.pnl_usd          || null,
      rr:              rest.rr               || null,
      result,
      rules_checklist: rest.rules_checklist  || null,
      mood:            rest.mood             || null,
      discipline:      rest.discipline       || null,
      reflection:      rest.reflection       || null,
      notes:           rest.notes            || null,
      screenshot_url:  screenshot_url        || null,
      updated_at:      new Date().toISOString(),
    };

    let savedRow;

    if (edit_id) {
      // Update existing trade — the student_id filter (resolved from the
      // session, not client input) means this can only ever match a row
      // that belongs to the caller.
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/journal_trades?id=eq.${encodeURIComponent(edit_id)}&student_id=eq.${encodeURIComponent(student_id)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=representation',
          },
          body: JSON.stringify(row),
        }
      );
      if (!patchRes.ok) throw new Error(`Update failed: ${patchRes.status}`);
      const rows = await patchRes.json();
      savedRow = rows?.[0];

      if (!savedRow) {
        // 0 rows matched — either the trade doesn't exist, or it belongs
        // to someone else. Either way, don't confirm which.
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Trade not found.' }) };
      }
    } else {
      // Insert new trade with the pre-generated ID
      const insertRow = { ...row, id: tradeId, created_at: new Date().toISOString() };
      const postRes = await fetch(`${SUPABASE_URL}/rest/v1/journal_trades`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',
        },
        body: JSON.stringify(insertRow),
      });
      if (!postRes.ok) {
        const text = await postRes.text();
        throw new Error(`Insert failed: ${postRes.status} ${text}`);
      }
      const rows = await postRes.json();
      savedRow = rows?.[0];
    }

    console.log('[journal-save] ✓ trade saved:', savedRow?.id, 'pair:', pair);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, trade: savedRow }),
    };

  } catch (err) {
    console.error('[journal-save]', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: err.message }),
    };
  }
};