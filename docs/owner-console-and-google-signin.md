# CedarBite owner console and Cedar Google sign-in

## Owner console

The canteen workspace is a separate app-style screen at `/owner`. A signed-in
Cedar account needs the existing `manager`, `staff`, or `owner` permissions to
use the corresponding tools. The backend checks permissions on every write.

Managers can add menu categories and items, update prices, and add or hide
preview promotions. Staff with the availability permission can mark an item
available or unavailable. Staff with queue permissions can move orders through
the kitchen workflow. Checkout and live payment providers remain disabled.

The preview's sample deals are stored in the current browser only. They do not
change prices, order totals, or other browsers. They are a design preview, not
a shared canteen promotion system.

## Cedar Google sign-in setup

Google sign-in is disabled until the college domain administrator configures a
Web OAuth client. Do not paste OAuth secrets into chat or commit them to Git.

1. In Google Cloud Console, create/select a project and configure the OAuth
   consent screen for the Cedar College Workspace.
2. Create an OAuth client with application type **Web application**.
3. Add the production origin as an authorized JavaScript origin, for example
   `https://canteen.example.edu`.
4. Add this exact authorized redirect URI:
   `https://canteen.example.edu/api/auth/google/callback`
5. Set these server-side environment variables in the deployment host:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAIN=cedar.edu.pk`,
   and `PUBLIC_BASE_URL=https://canteen.example.edu`.
6. Ask the Workspace administrator whether the consent screen should be
   **Internal** and whether the OAuth client is allowed for Cedar users.

The server uses Google's signed ID token validation, checks the verified
Workspace `hd` claim against `ALLOWED_EMAIL_DOMAIN`, and checks the OAuth
state and nonce. It requests only `openid`, `email`, and `profile`. A new Cedar
student with the expected seven-digit address can receive a student account;
Google sign-in never grants a staff or owner role. The owner must provision
canteen staff separately. Staff provisioning is available through the
owner-only `POST /api/admin/users` endpoint; a staff-management screen has not
been built yet. Provision a manager or staff account with its Cedar email before
that person signs in with Google.

Google's OAuth documentation requires validating the authorization state and
the signed ID token. In particular, use the signed hosted-domain (`hd`) claim
to confirm Workspace membership rather than trusting only the email suffix.

## Starter menu

The development seed contains fictional example names and PKR prices. In a
development environment, run `python -m app.cli seed-dev-menu` from `backend/`
once. It adds the examples only when the menu is empty. After that, update menu
names, descriptions, categories, prices, and availability in **Canteen console
→ Menu**. Confirm every item, ingredient, price, and pickup mode with the
canteen before any approved service is launched.

The seed command refuses to run when `CEDARBITE_ENV=production`.
