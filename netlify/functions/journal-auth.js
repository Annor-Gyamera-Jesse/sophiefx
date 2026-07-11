/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-auth.js
 * Netlify Function: POST /.netlify/functions/journal-auth
 *
 * Two valid access paths:
 *   1. booking_ref — must exist in the bookings table (paid student)
 *   2. password + identifier — password must match JOURNAL_PASSWORD,
 *      and "identifier" (name or email, typed by the student) is what
 *      makes their student_id unique.
 *
 *      We no longer derive password-path student_id from IP address.
 *      IP is shared across many students on the same WiFi/campus
 *      network/mobile carrier (very common with CGNAT), which meant
 *      different students collided onto the exact same journal.
 *
 * SECURITY MODEL:
 *   This endpoint used to hand the deterministic student_id straight
 *   to the browser, and journal-fetch/save/delete just trusted
 *   whatever student_id the client sent back — the student_id itself
 *   WAS the credential. Now:
 *
 *     - This endpoint computes student_id server-side only.
 *     - It generates a random, unguessable session token and stores
 *       {token -> student_id} in the journal_sessions table.
 *     - Only the TOKEN is returned to the browser. The browser can
 *       never learn or declare its own student_id.
 *     - journal-fetch/save/delete resolve the token to a student_id
 *       themselves on every request (see JOURNAL_SESSIONS_MIGRATION.sql).
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   JOURNAL_PASSWORD     = class password Sophie gives offline students
 *   JOURNAL_ID_SECRET    = HMAC secret (set in Netlify — no fallback, see below)
 * ============================================================
 */

import crypto from 'crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JOURNAL_PASSWORD     = process.env.JOURNAL_PASSWORD;

const SESSION_TTL_DAYS = 90;

// ── Rate limiting (in-memory, resets on cold start) ─────────
// This is a login endpoint — keep the limit tight to slow down
// anyone trying to brute-force booking refs or the class password.
const rateMap    = new Map();
const RATE_LIMIT  = 10;
const RATE_WINDOW = 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.window > RATE_WINDOW) {
    rateMap.set(ip, { window: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Deterministic student ID — computed server-side only, never sent to the client.
function makeStudentId(identifier) {
  const secret = process.env.JOURNAL_ID_SECRET;
  if (!secret) {
    // No hardcoded fallback anymore — fail loudly instead of silently
    // using a secret that's sitting in the source code.
    throw new Error('JOURNAL_ID_SECRET not configured');
  }
  return crypto.createHmac('sha256', secret).update(identifier.toLowerCase().trim()).digest('hex').slice(0, 32);
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars — unguessable
}

async function createSession(student_id, access_type, label) {
  const token      = makeSessionToken();
  const expires_at = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/journal_sessions`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ token, student_id, access_type, label, expires_at }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase session insert failed: ${res.status} ${text}`);
  }

  return token;
}

export const handler = async (event) => {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
  }

  // ── Rate limit by IP ──────────────────────────────────────
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Too many attempts. Please wait a few minutes and try again.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { booking_ref, password, identifier } = body;

  if (!booking_ref && !password) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Provide a booking reference or class password.' }),
    };
  }

  // ── PATH 1: booking_ref ───────────────────────────────────
  if (booking_ref) {
    const ref = booking_ref.trim().toUpperCase();

    // Basic format validation
    if (!/^(SA|BK|BANK-SA|BANK-BK)-[A-Z0-9]{4,20}(-[A-Z0-9]{1,6})?$/i.test(ref)) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Invalid booking reference format.' }),
      };
    }

    try {
      const cleanRef = ref.replace(/^BANK-/, ''); // strip BANK- prefix for lookup
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/bookings?or=(booking_ref.eq.${encodeURIComponent(cleanRef)},reference.eq.${encodeURIComponent(cleanRef)},booking_ref.eq.${encodeURIComponent(ref)})&select=booking_ref,customer_name,customer_email&limit=1`,
        {
          headers: {
            'apikey':        SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Accept':        'application/json',
          },
        }
      );

      if (!res.ok) throw new Error(`Supabase ${res.status}`);
      const rows = await res.json();

      if (!rows || !rows.length) {
        console.warn('[journal-auth] booking_ref not found:', ref);
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'Booking reference not found. Check for typos or use the class password.' }),
        };
      }

      const booking    = rows[0];
      const student_id = makeStudentId(cleanRef);
      const token       = await createSession(student_id, 'booking', cleanRef);

      console.log('[journal-auth] ✓ booking_ref access:', cleanRef);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success:       true,
          session_token: token,
          name:          booking.customer_name || 'Student',
          access_type:   'booking',
        }),
      };

    } catch (err) {
      console.error('[journal-auth] Supabase error:', err.message);
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Verification failed. Try again.' }) };
    }
  }

  // ── PATH 2: password ──────────────────────────────────────
  if (password) {
    if (!JOURNAL_PASSWORD) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Class password not configured. Contact Sophie.' }) };
    }

    // Constant-time comparison to prevent timing attacks
    const provided = Buffer.from(password.trim());
    const expected = Buffer.from(JOURNAL_PASSWORD);
    const match    = provided.length === expected.length
      && crypto.timingSafeEqual(provided, expected);

    if (!match) {
      console.warn('[journal-auth] wrong class password attempt');
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Wrong class password. Ask Sophie for the correct one.' }),
      };
    }

    // The password is shared by the whole class, so it can never be
    // what makes a student unique. Every password-access student must
    // also supply something that's theirs — name or email — which
    // replaces the old IP-based partitioning (IP is shared across many
    // students on the same network and caused journal collisions).
    const id = (identifier || '').trim();
    if (!id || id.length < 2) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Please also enter your name or email so your journal stays separate from other students.' }),
      };
    }

    try {
      const student_id = makeStudentId(`password:${id}`);
      const token       = await createSession(student_id, 'password', id);

      console.log('[journal-auth] ✓ password access for', id);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success:       true,
          session_token: token,
          name:          id,
          access_type:   'password',
        }),
      };
    } catch (err) {
      console.error('[journal-auth] session creation error:', err.message);
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Could not start session. Try again.' }) };
    }
  }
};