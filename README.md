# CedarBite

CedarBite is a student portfolio project exploring college canteen ordering and queue management. It is **not approved by or operated at Cedar College**, and it is not a live service. Do not enter real payment credentials or student records into a development deployment.

## Current build

- FastAPI backend with persistent SQLAlchemy models, session-based authentication, CSRF protection, role permissions, menu management, Quick/Scheduled order rules, pickup windows, order tracking, and a staff fulfilment queue.
- Student self-registration accepts a seven-digit ID at `@cedar.edu.pk`. The ID is derived from the email and returned only in that student's own profile response; it is not copied into another database field.
- Responsive React/TypeScript website. It uses the real backend APIs and displays live menu data. It supports sign-in, registration, menu browsing, a basket price check, order history, staff queue actions, and menu availability controls.
- Alembic initial database migration and a Docker Compose development setup.
- EasyPaisa, JazzCash, bank/Raast transfer, card, and cash are listed as intended payment options, but all remain unavailable. No provider integration or merchant account is configured. Checkout is blocked; no payment can be reported as successful.
- Registration email delivery is not configured. A real deployment needs a transactional email service before students can complete verification.
- Aggregate analytics, provider-specific payments, refund processing, and production deployment are not complete.

College/canteen approval and merchant onboarding are separate requirements. Until those are complete, keep the site marked as a development project and use only clearly labelled sample menu data.

## Local development

### Backend

From `backend/`, create and activate a Python virtual environment, install the project dependencies, then run the API:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
$env:ALLOWED_EMAIL_DOMAIN = "cedar.edu.pk"
$env:EMAIL_BACKEND = "console"
python -m uvicorn app.main:create_app --factory --reload
```

The development API is available at `http://127.0.0.1:8000`. The API documentation is at `/docs`. `EMAIL_BACKEND=console` prints verification links to the local API terminal; it is development-only. Registration remains closed unless `ALLOWED_EMAIL_DOMAIN` is set to `cedar.edu.pk`.

### Website

From `frontend/` in another terminal:

```powershell
npm install
npm run dev
```

Open the address printed by Vite (normally `http://localhost:5173`). Vite forwards `/api` requests to the backend.

To build the website into the backend's static asset directory:

```powershell
npm run build
```

Then open `http://127.0.0.1:8000` to serve the built site from FastAPI.

### Development sample data

Sample menu items are fictional and include a `[DEV SAMPLE]` label. From `backend/` with the virtual environment active:

```powershell
python -m app.cli seed-dev-menu
```

Create an initial local owner account interactively; do not put the password in source code:

```powershell
python -m app.cli create-owner --email owner@example.edu.pk
```

## Tests

Backend:

```powershell
cd backend
python -m unittest discover -s tests -t . -v
```

Website:

```powershell
cd frontend
npm test
npm run build
```

## Deployment status

The Docker Compose file prepares a public HTTPS website behind Caddy, but no host or domain has been selected and the app has not been deployed. A public host, authorized domain, configured SMTP delivery, database backup/retention plan, college/canteen approval, and merchant accounts are still required. The application deliberately keeps payment processing unavailable until provider-specific integrations are implemented and verified end to end.

See [docs/deployment.md](docs/deployment.md), [docs/merchant-onboarding.md](docs/merchant-onboarding.md), [docs/payment-integration.md](docs/payment-integration.md), and [docs/ownership-handover.md](docs/ownership-handover.md) before planning a pilot.
