# Website deployment preparation

The Docker Compose configuration is ready for a Linux host with Docker Compose, a domain, and authorized production credentials. It is not deployed yet. Do not expose CedarBite as an official Cedar College service until the COO and canteen operator approve the pilot.

## What you need first

- A host you control, with Docker Engine and the Compose plugin.
- A domain authorized for the project, with DNS pointing to the host.
- Inbound ports 80 and 443 reachable so Caddy can obtain and renew HTTPS certificates.
- The merchant-owned PostgreSQL database password and a long random `SESSION_SECRET`.
- A transactional SMTP account for verification emails, with authenticated STARTTLS on port 587.
- Written college/canteen approval and agreed data, refund, support, and operational responsibilities.

## Deployment sequence

1. Build and review the project locally. Run backend tests, frontend tests, and the frontend production build.
2. Back up any existing database. The first production startup runs `alembic upgrade head`; never point it at a database containing data until the migration has been reviewed.
3. Configure the environment variables used by `compose.yaml` in the host's secret manager or a local, untracked Compose environment file: `POSTGRES_PASSWORD`, `SESSION_SECRET`, `PUBLIC_HOST`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and `SMTP_FROM_EMAIL`. Use a URL-safe random password for `POSTGRES_PASSWORD` because the compose file embeds it in the database URL.
4. Point the authorized domain's DNS A/AAAA records to the host and confirm firewall access to ports 80 and 443.
5. Run `docker compose up --build -d`. Caddy terminates HTTPS; the application is exposed only behind Caddy. The app runs database migrations before starting.
6. Create the first application owner through the container's setup CLI, using a password prompt. Do not put the password in the command line or source code.
7. Verify HTTPS, account-verification email delivery, access controls, backups, logs, and incident contacts. Keep payment methods disabled until merchant accounts and provider integrations are approved and tested.

This file does not select a hosting vendor, domain, or merchant. Those remain with the project owner and authorized college/canteen operator.
