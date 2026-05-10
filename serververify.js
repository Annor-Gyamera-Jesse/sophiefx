/**
 * ============================================================
 * SOPHIE FX — PAYSTACK SERVER VERIFICATION ENDPOINT
 * ============================================================
 *
 * Why this file exists:
 *   The frontend calls Paystack with a PUBLIC key. After the
 *   user completes payment, Paystack fires an onSuccess callback
 *   in the browser. THAT CALLBACK CAN BE FAKED. A malicious user
 *   can monkey-patch JavaScript and trigger your "success" modal
 *   without ever paying.
 *
 *   The ONLY trustworthy confirmation is to call Paystack's verify
 *   endpoint from your server, using your SECRET key:
 *
 *     GET https://api.paystack.co/transaction/verify/:reference
 *     Authorization: Bearer sk_live_xxxxxxxxxxxx
 *
 *   You then check:
 *     - data.status === 'success'
 *     - data.amount === expected_amount (in pesewas/kobo)
 *     - data.currency === expected_currency
 *
 *   Only when all three match do you grant access / send confirmation.
 *
 * ============================================================
 * DEPLOY TO ANY OF:
 *   - Vercel Serverless Function (rename to api/verify-payment.js)
 *   - Netlify Function
 *   - Cloudflare Workers (slightly different syntax)
 *   - Render / Railway / Fly.io as a Node service
 *   - Plain Express server
 * ============================================================
 *
 * ENV VARS REQUIRED:
 *   PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   ALLOWED_ORIGIN=https://sophie.fx          (your frontend domain)
 *   SMTP_HOST / SMTP_USER / SMTP_PASS         (optional — for emails)
 *   SOPHIE_EMAIL=andersonwalker509@gmail.com
 *
 * ============================================================
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { Pool } from 'pg';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

// CORS — lock to your frontend domain in prod
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['POST', 'GET', 'OPTIONS'],
}));

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_API = 'https://api.paystack.co';
const DATABASE_URL = process.env.DATABASE_URL;

if (!PAYSTACK_SECRET) {
  console.error('FATAL: PAYSTACK_SECRET_KEY env var not set');
  process.exit(1);
}

const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
if (!DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set; booking persistence disabled');
} else {
  initPostgres().catch(err => console.error('[db] init failed', err));
}

/* ============================================================
 * In-memory idempotency cache so the same reference can't be
 * "verified" twice and trigger duplicate emails. In production,
 * use Redis or your database.
 * ============================================================ */
const verifiedRefs = new Map();
function alreadyVerified(ref) {
  // expire after 24h
  const entry = verifiedRefs.get(ref);
  if (!entry) return null;
  if (Date.now() - entry.at > 24 * 60 * 60 * 1000) {
    verifiedRefs.delete(ref);
    return null;
  }
  return entry;
}
function markVerified(ref, payload) {
  verifiedRefs.set(ref, { at: Date.now(), payload });
}

/* ============================================================
 * POST /verify-payment
 *
 * Body: { reference, expected_amount_pesewas, expected_currency, booking_ref }
 *
 * Returns: { success: boolean, message: string, data?: {...} }
 * ============================================================ */
app.post('/verify-payment', async (req, res) => {
  const { reference, expected_amount_pesewas, expected_currency, booking_ref } = req.body || {};

  if (!reference || typeof reference !== 'string') {
    return res.status(400).json({ success: false, message: 'reference is required' });
  }

  // Idempotency: if we've already verified, return the cached result
  const cached = alreadyVerified(reference);
  if (cached) {
    return res.json({ success: true, message: 'Already verified', data: cached.payload, cached: true });
  }

  try {
    const psRes = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
    });

    if (!psRes.ok) {
      return res.status(502).json({
        success: false,
        message: `Paystack returned HTTP ${psRes.status}`,
      });
    }

    const body = await psRes.json();
    const tx = body?.data;

    if (!tx) {
      return res.status(502).json({ success: false, message: 'Empty response from Paystack' });
    }

    // === The three checks that matter ===
    const statusOk   = tx.status === 'success';
    const amountOk   = !expected_amount_pesewas || Number(tx.amount) === Number(expected_amount_pesewas);
    const currencyOk = !expected_currency || tx.currency === expected_currency;

    if (!statusOk) {
      return res.json({
        success: false,
        message: `Transaction status: ${tx.status} — ${tx.gateway_response || 'not successful'}`,
        data: { status: tx.status, gateway_response: tx.gateway_response },
      });
    }
    if (!amountOk) {
      // CRITICAL: amount mismatch is a red flag — could be tampering
      console.error(`[SECURITY] Amount mismatch for ref ${reference}: expected ${expected_amount_pesewas}, got ${tx.amount}`);
      return res.json({
        success: false,
        message: `Amount mismatch: expected ${expected_amount_pesewas}, got ${tx.amount}`,
      });
    }
    if (!currencyOk) {
      console.error(`[SECURITY] Currency mismatch for ref ${reference}: expected ${expected_currency}, got ${tx.currency}`);
      return res.json({
        success: false,
        message: `Currency mismatch: expected ${expected_currency}, got ${tx.currency}`,
      });
    }

    // === All checks passed — fulfil the order ===
    const payload = {
      reference:        tx.reference,
      amount:           tx.amount,
      currency:         tx.currency,
      paid_at:          tx.paid_at,
      channel:          tx.channel,                   // card / bank / mobile_money / ussd
      customer_email:   tx.customer?.email,
      customer_name:    `${tx.customer?.first_name || ''} ${tx.customer?.last_name || ''}`.trim(),
      gateway_response: tx.gateway_response,
      booking_ref:      tx.metadata?.booking_ref || booking_ref,
      tier:             tx.metadata?.tier,
    };

    markVerified(reference, payload);

    // Side-effects: persist to DB, send emails, schedule WhatsApp, etc.
    // Failures here MUST NOT cause us to return failure to the client —
    // the payment is verified. Log and move on.
    try {
      await persistBooking(payload);
      await sendConfirmationEmails(payload);
    } catch (sideErr) {
      console.error('[verify] post-verify side-effect failed', sideErr);
    }

    return res.json({ success: true, message: 'Verified', data: payload });

  } catch (err) {
    console.error('[verify] error', err);
    return res.status(500).json({ success: false, message: 'Verification failed: server error' });
  }
});

/* ============================================================
 * POST /paystack-webhook
 *
 * Paystack also POSTs a `charge.success` event to a webhook URL
 * you configure in your Paystack dashboard. This is the most
 * reliable confirmation channel — webhooks fire even if the user
 * closes their browser before onSuccess runs.
 *
 * Configure in Paystack Dashboard:
 *   Settings → API Keys & Webhooks → Webhook URL
 *   e.g. https://api.sophie.fx/paystack-webhook
 *
 * Verify the signature using your SECRET key + HMAC SHA512.
 * ============================================================ */
app.post('/paystack-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    // Paystack sends x-paystack-signature header
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('No signature');

    const expected = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)  // raw body buffer
      .digest('hex');

    if (signature !== expected) {
      console.warn('[webhook] signature mismatch');
      return res.status(401).send('Invalid signature');
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    // Always 200 quickly — Paystack will retry on non-2xx
    res.sendStatus(200);

    if (event.event === 'charge.success') {
      const tx = event.data;
      console.log('[webhook] charge.success', tx.reference, tx.amount, tx.currency);

      // Same idempotency + persistence as /verify-payment
      if (alreadyVerified(tx.reference)) return;

      const payload = {
        reference:        tx.reference,
        amount:           tx.amount,
        currency:         tx.currency,
        paid_at:          tx.paid_at,
        channel:          tx.channel,
        customer_email:   tx.customer?.email,
        gateway_response: tx.gateway_response,
        booking_ref:      tx.metadata?.booking_ref,
        tier:             tx.metadata?.tier,
      };
      markVerified(tx.reference, payload);

      // Don't await — fire and log
      Promise.allSettled([
        persistBooking(payload),
        sendConfirmationEmails(payload),
      ]).then(results => {
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.error(`[webhook] side-effect ${i} failed`, r.reason);
        });
      });
    }
  }
);

/* ============================================================
 * Side effects — replace with your real DB + email logic
 * ============================================================ */
async function persistBooking(payload) {
  if (!pgPool) {
    console.warn('[persist] skipping Postgres persistence because DATABASE_URL is not set');
    return;
  }

  const sql = `
    INSERT INTO bookings (
      reference,
      booking_ref,
      tier,
      amount,
      currency,
      paid_at,
      channel,
      customer_email,
      customer_name,
      gateway_response
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (reference) DO UPDATE SET
      booking_ref = EXCLUDED.booking_ref,
      tier = EXCLUDED.tier,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      paid_at = EXCLUDED.paid_at,
      channel = EXCLUDED.channel,
      customer_email = EXCLUDED.customer_email,
      customer_name = EXCLUDED.customer_name,
      gateway_response = EXCLUDED.gateway_response;
  `;

  await pgPool.query(sql, [
    payload.reference,
    payload.booking_ref,
    payload.tier,
    payload.amount,
    payload.currency,
    payload.paid_at || null,
    payload.channel,
    payload.customer_email,
    payload.customer_name,
    payload.gateway_response,
  ]);
  console.log('[persist] saved booking', payload.reference);
}

async function initPostgres() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      reference TEXT PRIMARY KEY,
      booking_ref TEXT,
      tier TEXT,
      amount BIGINT NOT NULL,
      currency TEXT NOT NULL,
      paid_at TIMESTAMPTZ,
      channel TEXT,
      customer_email TEXT,
      customer_name TEXT,
      gateway_response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function sendConfirmationEmails(payload) {
  // TODO: use nodemailer / Postmark / Resend / SendGrid
  // Send one to the client and one to Sophie
  console.log('[email] sending to', payload.customer_email, 'and', process.env.SOPHIE_EMAIL);
}

/* ============================================================
 * Health check
 * ============================================================ */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] verify endpoint: POST /verify-payment`);
  console.log(`[server] webhook endpoint: POST /paystack-webhook`);
});