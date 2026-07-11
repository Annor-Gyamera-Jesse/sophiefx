/**
 * ============================================================
 * PIPS BUILT ACADEMY — journal-auth.js
 * Netlify Function: POST /.netlify/functions/journal-auth
 *
 * Two valid access paths:
 *   1. booking_ref — must exist in the bookings table (paid student)
 *   2. password    — must match JOURNAL_PASSWORD env var (offline student)
 *
 * On success returns a student_id (deterministic hash of their identifier)
 * which is used as the partition key for all their journal entries.
 * No JWT, no cookies — the student_id is stored in localStorage by the
 * frontend and sent as X-Journal-Session on every subsequent request.
 *
 * ENV VARS REQUIRED:
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 *   JOURNAL_PASSWORD     = class password Sophie gives offline students
 * ============================================================
 */

import crypto from 'crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JOURNAL_PASSWORD     = process.env.JOURNAL_PASSWORD;

// Deterministic student ID from booking_ref or password-based email
// Using HMAC-SHA256 so the raw identifier is never exposed
function makeStudentId(identifier) {
  const secret = process.env.JOURNAL_ID_SECRET || 'pba-journal-secret-v1';
  return crypto.createHmac('sha256', secret).update(identifier.toLowerCase().trim()).digest('hex').slice(0, 32);
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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) };
  }

  const { booking_ref, password } = body;

  if (!booking_ref && !password) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, message: 'Provide a booking reference or class password.' }),
    };
  }

  // ── PATH 1: booking_ref ───────────────────────────────────
  if (booking_ref) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ success: false, message: 'Server misconfiguration' }) };
    }

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
      // Check both booking_ref column and reference column (handles BANK- prefix refs too)
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

      const booking = rows[0];
      const student_id = makeStudentId(cleanRef);

      console.log('[journal-auth] ✓ booking_ref access:', cleanRef);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success:     true,
          student_id,
          name:        booking.customer_name || 'Student',
          access_type: 'booking',
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

    // For password-based access we can't give a unique student_id per person,
    // so we generate one from the password + IP — enough to partition data
    const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const student_id = makeStudentId(`password:${ip}:${password}`);

    console.log('[journal-auth] ✓ password access');
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:     true,
        student_id,
        name:        'Student',
        access_type: 'password',
      }),
    };
  }
};
