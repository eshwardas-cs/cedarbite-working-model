# Supabase + Cedar Google sign-in: setup

This branch adds an optional Supabase backend for two things:

1. **Menu**: categories, items and photos are read from Supabase.
2. **Sign-in**: Google sign-in through Supabase, limited to Cedar College Google accounts.

**Safety switch:** nothing changes until `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set.
Without them the app keeps its current menu and sign-in behaviour.

Orders, wallet and payments are **not** part of this change. They still use the existing code.

---

## How "Cedar accounts only" is enforced

The `hd=cedar.edu.pk` parameter sent to Google only changes which accounts Google *shows*, so it is not
security. The real check is a database trigger (`supabase/migrations/0002_auth_cedar_only.sql`) that runs
**before** any account is created. It allows only:

- a **Google** sign-in whose email ends in `@cedar.edu.pk` **and** whose Google-signed hosted-domain
  claim (`hd`) is `cedar.edu.pk`, or
- an email the owner has added to `public.staff_allowlist` (canteen staff, any email).

Everything else is refused and no account is created. The sign-in provider is read from
`raw_app_meta_data`, which Supabase sets and users cannot fake.

Each allowed person gets a row in `public.profiles` with a role. Seven-digit Cedar emails become
`student`, other Cedar emails become `teacher`, and staff-list emails get the role on their list entry.
People can read only their own profile and cannot change roles.

---

## Setup (team Supabase account)

Never commit or share the **secret** key, the Google **client secret**, or any `.env*` file.

### 1. Supabase project
Create a project in the team account. In **Project Settings → API Keys**, note the **Project URL**
(base URL only, without `/rest/v1`) and the **publishable** key.

### 2. Database
In **SQL Editor**, run these files in order (each one is safe to run again):
1. `supabase/migrations/0001_menu.sql`: menu tables, read-only security rules and the `menu-images` photo bucket.
2. `supabase/migrations/0002_auth_cedar_only.sql`: the Cedar-only sign-in rule, profiles and the staff list.
3. `supabase/migrations/0003_menu_editing.sql`: item order (`sort_order`) and two server-only functions
   for reordering the menu and removing a category. Run it **before** deploying the menu-editing code.
4. `supabase/migrations/0004_orders.sql`: the `orders` table (server-only: no access for browser keys).
   Run it **before** deploying the code that keeps orders in Supabase. On the first request after that
   deploy, the function copies the orders saved in Netlify storage into this table once (marker
   `meta/orders-in-supabase-v1`); the Netlify copies stay as a backup.
5. `supabase/migrations/0005_order_cancel.sql`: cancelled orders leave the kitchen queue (`is_active` now
   means "not collected and not cancelled"). Run it **before** deploying "Cancel order".

### 3. Menu data (one-time import)
This copies `frontend/src/catalog.json` (14 categories, 51 items and their photos) into Supabase:
1. Create `frontend/.env.local` with `VITE_SUPABASE_URL=` and `VITE_SUPABASE_PUBLISHABLE_KEY=` filled in.
2. Create `supabase/.env.admin` with `SUPABASE_SECRET_KEY=` filled in. This file is git-ignored.
3. From `frontend/`, run `node scripts/import-menu.mjs` first. That is a dry run and changes nothing.
4. Then run `node scripts/import-menu.mjs --go`. It refuses to run if `menu_items` already has rows.
5. Delete the secret key from `supabase/.env.admin` afterwards.

### 4. Google OAuth client (Google Cloud → Google Auth Platform → Clients)
Create a **Web application** client:
- **Authorized JavaScript origins:** the live site (e.g. `https://<site>.netlify.app`) and `http://localhost:5173`
- **Authorized redirect URI:** `https://<project-ref>.supabase.co/auth/v1/callback`

**Audience:** while the app is in **Testing**, only the listed test users can sign in. Before students use
it, complete **Branding** (home page, privacy policy page `/privacy-policy`, authorized domain) and click
**Publish app**. Only the `openid`, `email` and `profile` scopes are used.

### 5. Supabase Auth settings
- **Authentication → Sign In / Providers → Google:** turn it on, paste the Client ID and Client secret, then save.
- **Authentication → URL Configuration:**
  - **Site URL:** the live site URL.
  - **Redirect URLs:** add `https://<site>.netlify.app/**` and `http://localhost:5173/**`. For Netlify
    deploy previews, also add `https://**--<site>.netlify.app/**`.

### 6. Netlify
In **Site configuration → Environment variables**, add `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`, then **trigger a new deploy**. Vite builds these values into the site,
so they only take effect after a deploy.

The publishable key is meant to be public. Security comes from the database rules.

**Staff menu editing** also needs the **secret** key, used only by the Netlify function
(`frontend/netlify/functions/shared-data.mjs` → `frontend/shared/menu-store.mjs`):
- Add `SUPABASE_SECRET_KEY` (the `sb_secret_...` key) with **Contains secret values** ticked.
  Fill in **Production** and **Deploy Previews** only; leave **Local development** empty (Netlify does
  not treat that one as secret). On the free plan the scopes can't be narrowed (Builds, Functions and
  Runtime stay ticked); that is fine because the build only bundles `VITE_*` variables, and Netlify's
  secret scanning stops a deploy if the key ever appears in the built files. Redeploy afterwards.
- Never name it `VITE_*` and never import `shared/menu-store.mjs` from `src/`: anything `VITE_*` or under
  `src/` is shipped to every visitor's browser.
- The function checks the order-manager station password first, then saves the change to Supabase.

### 6b. How the menu flows (after `0003`)
- **Students** read the menu straight from Supabase (`src/menuApi.ts`, publishable key, read-only).
- **Staff** change it through the station screens. The browser sends one small change (sold out, one
  price, one item, one category, or the new order) to the Netlify function, which saves it to Supabase.
- **Orders** are priced by the Netlify function from the Supabase menu, never from the browser's price.
- **Online orders need a Cedar Google sign-in.** The browser sends the person's Supabase sign-in token with
  the order; the Netlify function (`frontend/shared/customer-auth.mjs`) asks Supabase whose token it is and
  reads their profile with the secret key. The student ID saved on the order comes from that profile, never
  from the browser. An order without a valid sign-in is refused and nothing is saved.
- **Orders live in Supabase** (`public.orders`, via `frontend/shared/order-store.mjs`). Each row keeps the
  whole order in `data` plus searchable copies (status, customer, totals, times). A status change only
  saves if no other screen changed the order first.
- **My orders:** the `?scope=my-orders` request needs the same sign-in token and returns only that person's
  orders (refreshed every 10 seconds on the My orders page). Online orders placed before PR #4 have no
  owner, so they don't appear on anyone's list.
- **Cancel order:** on My orders, a signed-in customer can cancel their own order only while it is
  `SUBMITTED` and unpaid (`cancel-order` action). The save only happens if the order is still `SUBMITTED`,
  so if the kitchen accepts it at the same moment, the kitchen wins. Cancelled orders leave the queue, move
  to history, can't be moved on or marked paid by staff, and don't count as "orders placed" in sales.
- **Wallet payment is switched off** until the wallet moves to Supabase: nothing can check a balance yet, so
  the server refuses `wallet` orders instead of marking them paid, and checkout no longer offers it.
- Netlify storage no longer holds menu or order data. Deals are still stored there for now, checked against
  the Supabase menu.

### 7. Staff accounts (optional)
Add the person's email and role (`staff` / `manager` / `owner`) to **Table Editor → staff_allowlist**
*before* creating their account. Staff sign-in screens are not part of this change yet.

---

## How it was tested (on a separate test project)

| Check | Result |
|---|---|
| A Cedar Google account (`@cedar.edu.pk`) signs in | Account and profile created with the `student` role; `hd` claim = `cedar.edu.pk` |
| A personal Gmail signs in through Google | Refused, no account created, and a friendly "Cedar accounts only" message is shown |
| Email + password sign-up (personal email) | Refused |
| Email + password sign-up with a fake Cedar email and forged Google/`hd` metadata | Refused |
| Anonymous sign-in | Refused (disabled) |
| The publishable key tries to insert, update or delete menu rows, upload photos, or read `staff_allowlist` / `profiles` while logged out | All refused |
| Menu loaded from Supabase compared with `catalog.json` | All 51 items match on every field |
