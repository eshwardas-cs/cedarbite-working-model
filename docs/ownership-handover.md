# Handing CedarBite to the canteen (with the college having access)

Three separate things move, and they do not move together.

## 1. Software ownership (built into the app)
- The **owner** role is held by exactly one active account (the database enforces this).
- To hand over: the canteen creates an account and verifies its email. The current owner
  signs in, calls `POST /api/owner/transfer-ownership` (a screen for this comes later) with the new
  owner's email, the role the previous owner should keep, their own password again, and the
  phrase `TRANSFER OWNERSHIP`. It is one all-or-nothing change and is written to the audit log.
- The **college** gets one or more `college_admin` accounts. By default they see aggregate
  reports, audit events and college policy settings. They do NOT see payment settings or any
  individual student's orders. Change defaults in `app/auth/permissions.py`.
- The previous owner (the developers) can stay on as `college_admin` or any lower role, or be disabled.

## 2. Things outside the app that must also be handed over
| Item | Who should end up holding it |
|---|---|
| Hosting account / server | the canteen or college (or a named IT contact) |
| Domain name | the canteen or college |
| Database backups and who can restore them | the new owner plus one backup person |
| Email-sending account | the canteen or college |
| Source code and its licence | agree in writing who owns it and who may change it |
| `.env` secrets (session secret, DB password) | rotate them at handover; the old ones stay with the old owner otherwise |

## 3. Money (never moves by software)
- The payment merchant account must belong to the registered business that takes the money
  (likely the canteen), with its own business bank account. Settlement, refunds and
  reconciliation are that business's responsibility, agreed with the payment provider.
- Do not hand over payment credentials by chat or email. The new owner enters their own
  provider keys directly into the server's environment.

## Before the handover
- Written permission from the college for using student data and the college's name.
- A privacy notice covering what is stored and for how long.
- Someone named, on each side, for support questions.
