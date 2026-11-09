# Shared order queue on Netlify

The public storefront submits pickup orders to the Netlify Function in
`frontend/netlify/functions/shared-data.mjs`. The function stores each order
in the site-wide `cedarbite-shared-pilot` Netlify Blobs store. The canteen dashboard refreshes the queue every two seconds and
only loads active orders, so completed orders do not slow later refreshes.
Pending orders saved by the previous queue format are migrated the first time
the updated dashboard reads the queue. A collected order is removed from the
active queue.

The **menu** (items, prices, photos, sold-out switches, categories and their
order) is no longer kept here: it lives in **Supabase** (see
`docs/supabase-setup.md`). The function reads it from Supabase to price every
order and saves staff menu changes there through `frontend/shared/menu-store.mjs`.
Deals are still kept in this store and are checked against the Supabase menu.
An open student menu refreshes shared menu changes every five seconds; deal
presentation settings remain local to each browser.

The public endpoint can create an order and read the menu and availability.
Reading the shared queue, changing order status, changing the menu, and changing
item availability require the canteen password. Student IDs are returned only
in that manager-authenticated queue response.

## Configure the canteen password

In Netlify, open **Project configuration → Environment variables** and add:

- `CANTEEN_DASHBOARD_PASSWORD`: a unique, strong password known only to the
  canteen team. Do not commit it or place it in frontend code.
- `CANTEEN_DASHBOARD_USERNAME`: optional; defaults to `manager`.

Apply the variables to the **Production** deploy context and trigger a new
deploy. The dashboard will reject sign-in until the password is configured.
Use the same username and password on each canteen device. The password stays
in session storage for the active browser session and is sent only to this
site over HTTPS.

## Scope and limitations

- These are shared pickup-order records, not payment transactions. The wallet
  and payment choices remain presentation-only and must not be used to claim
  that money was received or transferred.
- Cedar email entry on the public student flow is not verified by Google in
  this deployment. Do not use real student IDs or present the flow as an
  authenticated college service until Cedar identity verification and approval
  are in place.
- The Netlify Blobs store is a small pilot store, not a replacement for the
  existing FastAPI/Postgres backend for an approved production service.
- Active queue entries are removed when an order is marked collected. Establish
  an approved retention period before collecting real student records.
