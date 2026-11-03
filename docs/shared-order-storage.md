# Shared order queue on Netlify

The public storefront submits pickup orders to the Netlify Function in
`frontend/netlify/functions/shared-data.mjs`. The function stores each order
and menu-availability change in the site-wide `cedarbite-shared-pilot` Netlify
Blobs store. The canteen dashboard refreshes the queue every five seconds.

The public endpoint can create an order and read menu availability. Reading the
shared queue, changing order status, and changing item availability require the
canteen password. Student IDs are returned only in that manager-authenticated
queue response.

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
- The current store keeps orders until the project operator clears them from
  Netlify Blobs. Establish and implement an approved retention period before
  collecting real student records.
