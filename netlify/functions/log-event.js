/**
 * ============================================================
 * SOPHIE FX — log-event.js
 * Netlify Function: POST /.netlify/functions/log-event
 *
 * Receives monitor events from index.html and writes them
 * to the Supabase `events` table.
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://jkwzknvialkjkykpgjko.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   MONITOR_SECRET       = your made-up secret token
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MONITOR_SECRET       = process.env.MONITOR_SECRET;

// ── Rate limiting (in-memory, resets on cold start) ─────────
// Max 60 events per IP per minute
const rateLimitMap = new Map();
const RATE_LIMIT   = 60;
const RATE_WINDOW  = 60 * 1000; // 1 minute

function isRateLimited(ip) {
  const now  = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.window > RATE_WINDOW) {
    rateLimitMap.set(ip, { window: now, count: 1 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return true;
  return false;
}

// ── Init Supabase table on cold start ───────────────────────
let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  try {
    const res = await supabaseQuery(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts BIGINT NOT NULL,
        level TEXT NOT NULL,
        tag TEXT NOT NULL,
        msg TEXT NOT NULL,
        data JSONB,
        stack TEXT,
        duration INTEGER,
        ref TEXT,
        email TEXT,
        amount TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS events_ts_idx    ON events(ts DESC);
      CREATE INDEX IF NOT EXISTS events_level_idx ON events(level);
      CREATE INDEX IF NOT EXISTS events_tag_idx   ON events(tag);
    `, null, 'rpc');
    tableReady = true;
  } catch (err) {
    // Table likely already exists — safe to continue
    tableReady = true;
    console.warn('[log-event] ensureTable warning:', err.message);
  }
}

// ── Supabase REST helper ─────────────────────────────────────
async function supabaseInsert(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }
}

async function supabaseQuery(sql, params, mode) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ query: sql }),
  });
  // We don't hard-fail here — table creation is best-effort
}

// ── Validate event shape ─────────────────────────────────────
function validateEvent(evt) {
  if (!evt || typeof evt !== 'object')        return false;
  if (typeof evt.id  !== 'string' || !evt.id) return false;
  if (typeof evt.ts  !== 'number')            return false;
  if (typeof evt.msg !== 'string')            return false;
  const validLevels = ['info','warn','error','success','payment','debug'];
  if (!validLevels.includes(evt.level))       return false;
  return true;
}

// ── Handler ──────────────────────────────────────────────────
export const handler = async (event, context) => {
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
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Method not allowed' }),
    };
  }

  // ── Secret token check ──────────────────────────────────────
  if (MONITOR_SECRET) {
    const token = event.headers['x-monitor-token'] || event.headers['X-Monitor-Token'];
    if (token !== MONITOR_SECRET) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Unauthorized' }),
      };
    }
  }

  // ── Rate limit by IP ────────────────────────────────────────
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || event.headers['client-ip']
           || 'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Rate limit exceeded' }),
    };
  }

  // ── Parse body ──────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Invalid JSON' }),
    };
  }

  // ── Handle batch or single event ────────────────────────────
  const evts = Array.isArray(body) ? body : [body];

  if (evts.length > 50) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Max 50 events per batch' }),
    };
  }

  // ── Guard: env vars must be set ─────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[log-event] Supabase env vars not set');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Server misconfiguration' }),
    };
  }

  await ensureTable();

  // ── Write events ────────────────────────────────────────────
  let written = 0;
  const errors = [];

  for (const raw of evts) {
    if (!validateEvent(raw)) {
      errors.push(`Invalid event shape: ${JSON.stringify(raw).slice(0, 80)}`);
      continue;
    }

    const row = {
      id:       raw.id,
      ts:       raw.ts,
      level:    raw.level,
      tag:      raw.tag   || 'general',
      msg:      String(raw.msg).slice(0, 2000),
      data:     raw.data  || null,
      stack:    raw.stack ? String(raw.stack).slice(0, 5000) : null,
      duration: raw.duration ? Number(raw.duration) : null,
      ref:      raw.ref   ? String(raw.ref).slice(0, 200)   : null,
      email:    raw.email ? String(raw.email).slice(0, 200) : null,
      amount:   raw.amount ? String(raw.amount).slice(0, 50) : null,
      ip,
    };

    try {
      await supabaseInsert(row);
      written++;
    } catch (err) {
      // If it's a duplicate ID, that's fine — skip silently
      if (err.message.includes('duplicate') || err.message.includes('23505')) {
        written++;
        continue;
      }
      errors.push(err.message);
      console.error('[log-event] insert error:', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success: true,
      written,
      errors: errors.length ? errors : undefined,
    }),
  };
};