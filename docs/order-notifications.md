# CedarBite order notifications

The student app sends the order receipt to the verified Cedar email returned by Google sign-in. When staff moves the order to **Ready**, CedarBite sends an opt-in web push alert to registered devices. **My Orders** also shows a persistent ready-to-collect notice, so students can still see the status if they have alerts turned off. If the order remains uncollected for 10 minutes after it became ready, a scheduled job sends one reminder email.

## Before deploying

1. Run [`supabase/migrations/0007_order_notifications.sql`](../supabase/migrations/0007_order_notifications.sql) in the CedarBite Supabase project's SQL Editor. It adds the ready timestamp, private push-subscription storage, and an idempotent email-delivery queue. Do this before deploying code that writes `orders.ready_at`.
2. In Resend, verify a CedarBite sending domain, then create an API key. Resend only sends from domains you own and have verified. You can use a sender such as `CedarBite <orders@cedarbite.me>` after `cedarbite.me` is verified.
3. Generate a VAPID key pair in the frontend folder with `npx web-push generate-vapid-keys`. Keep the private key server-only.
4. Add these Netlify environment variables. Never place the private values in frontend-prefixed variables or commit them:

   - `RESEND_API_KEY` — Resend API key.
   - `CEDARBITE_FROM_EMAIL` — sender using the verified domain, e.g. `CedarBite <orders@cedarbite.me>`.
   - `PUBLIC_SITE_URL` — `https://cedarbite.me`.
   - `VAPID_PUBLIC_KEY` — public key from the generated pair.
   - `VAPID_PRIVATE_KEY` — private key from the generated pair.
   - `VAPID_SUBJECT` — contact URI such as `mailto:eshdaskhanwani@gmail.com`.

5. Deploy the site. The scheduled reminder runs every minute on a published Netlify deployment, so the email is sent on the first run at or after the 10-minute mark. Netlify does not run scheduled functions automatically on branch previews.

Students enable push alerts themselves from **My Orders**. The app does not request notification permission during sign-in. On iPhone/iPad, they must add CedarBite to the Home Screen before enabling web push. If push is unavailable or blocked, the ready status remains visible in **My Orders** while the site is open.

Email sending is best-effort and retried from the private queue if the provider temporarily rejects a message. Resend idempotency keys and the database's unique order/type constraint prevent duplicate receipts or reminders during retries.
