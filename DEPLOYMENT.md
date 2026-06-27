# PIPS BUILT ACADEMY — Bank Transfer Feature Deployment Checklist
============================================================

## Step 1 — Supabase Setup
Run `SUPABASE_SETUP.sql` in your Supabase SQL Editor.
That creates the `pending_transfers` table and the `transfer-receipts` storage bucket.

## Step 2 — Add Netlify Environment Variables
Go to Netlify → Site → Site configuration → Environment variables → Add variable

Add these 4 new variables:

| Key                  | Value                         |
|----------------------|-------------------------------|
| ZENITH_ACCOUNT_NAME  | (Sophie's full account name)  |
| ZENITH_ACCOUNT_GHS   | (Zenith GH₵ account number)   |
| ZENITH_ACCOUNT_USD   | (Zenith USD domiciliary no.)  |
| ZENITH_SWIFT         | ZEBLGHAC                      |

> ZENITH_ACCOUNT_USD and ZENITH_SWIFT are optional.
> If not set, only the GH₵ account is shown to customers.
> ZEBLGHAC is Zenith Bank Ghana's standard SWIFT code — confirm with the bank.

All existing env vars (SUPABASE_URL, SUPABASE_SERVICE_KEY, MONITOR_SECRET, etc.) stay as-is.

## Step 3 — Deploy New Netlify Functions
Upload these 4 new files to your `netlify/functions/` directory:

- `get-bank-details.js`    — serves Zenith Bank details securely
- `submit-bank-transfer.js` — saves pending transfer to Supabase
- `get-pending-transfers.js` — admin fetch
- `approve-transfer.js`     — approve + activate WhatsApp link
- `reject-transfer.js`      — reject + notify

## Step 4 — Replace/Update HTML Files
- Replace `index.html` with the updated version
- Replace `admin.html` with the updated version (new 🏦 Bank Transfers tab added)

## Step 5 — Trigger Netlify Redeploy
Push to git or manually trigger a deploy in Netlify.

## Step 6 — Test
1. Go to the booking page → select Manual Wire
2. Bank details should load dynamically (not in page source)
3. Fill in the form, click "Confirm Booking"
4. Check Supabase → `pending_transfers` for the new row
5. Go to admin.html → Bank Transfers tab → approve/reject test booking

## How the full flow works

Customer path:
  1. Selects "Manual Wire" on payment step
  2. Bank details load from server (never in HTML source)
  3. Optionally uploads receipt (screenshot or PDF)
  4. Clicks "I've Made the Transfer — Confirm Booking"
  5. Backend saves booking to `pending_transfers` table
  6. Customer sees "Booking received — pending verification" screen

Admin path (admin.html → 🏦 Bank Transfers tab):
  1. Admin sees pending transfers with yellow ⏳ badge
  2. Clicks any row to see full customer details + receipt link
  3. Clicks ✓ APPROVE
     → booking row inserted into main `bookings` table
     → WhatsApp join link activates immediately
     → Admin sends confirmation email (EmailJS)
  4. Or clicks ✕ REJECT with a reason
     → Admin emails customer manually

## Security notes
- Bank account numbers NEVER appear in HTML source
- get-bank-details.js is rate-limited (20 req/IP/min)
- All admin functions require MONITOR_SECRET token
- Receipt files stored in a private Supabase Storage bucket
  (not publicly accessible — admin views via 7-day signed URL)
