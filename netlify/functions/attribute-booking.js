/**
 * ============================================================
 * PIPS BUILT ACADEMY — attribute-booking.js
 *
 * Add ONE LINE to your verify-payment.js after a successful
 * verification to attribute the booking to an affiliate.
 *
 * In verify-payment.js, after persistBooking(payload), add:
 *   await attributeAffiliate(payload.booking_ref, payload.amount, payload.tier, tx.metadata);
 *
 * ENV VARS (already in your Netlify dashboard):
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your service_role key
 * ============================================================
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMM_RATE_DEFAULT    = 20; // fallback if not set per affiliate

export async function attributeAffiliate(bookingRef, amountPesewas, tier, metadata) {
  // The affiliate code is passed in Paystack metadata if the booking
  // came through ?ref=CODE. The frontend stores it in sessionStorage
  // and passes it via the metadata object.
  const affiliateCode = metadata?.affiliate_ref;
  if (!affiliateCode) return; // no affiliate — nothing to do

  try {
    // 1. Look up the affiliate
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/affiliates?code=eq.${encodeURIComponent(affiliateCode)}&status=eq.approved&select=id,bookings,earned_ghs,comm_rate&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Accept': 'application/json' } }
    );
    if (!getRes.ok) return;
    const rows = await getRes.json();
    if (!rows || !rows.length) {
      console.warn(`[affiliate] code ${affiliateCode} not found or not approved`);
      return;
    }

    const aff        = rows[0];
    const rate       = (aff.comm_rate || COMM_RATE_DEFAULT) / 100;
    const amountGhs  = Math.round(amountPesewas / 100);
    const commission = Math.round(amountGhs * rate);

    // 2. Update affiliate stats
    await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${aff.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        bookings:   (aff.bookings   || 0) + 1,
        earned_ghs: (aff.earned_ghs || 0) + commission,
      }),
    });

    // 3. Tag the booking row with the affiliate code
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ affiliate_code: affiliateCode }),
    });

    console.log(`[affiliate] ✓ ${affiliateCode} earns GH₵${commission} for booking ${bookingRef}`);

  } catch (err) {
    // Never let affiliate tracking break the main payment flow
    console.error('[affiliate] attribution error (non-fatal):', err.message);
  }
}