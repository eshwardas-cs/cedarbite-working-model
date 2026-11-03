# Payment integration status

**No provider is integrated, no merchant account is configured, and live checkout is disabled.** The website lists EasyPaisa, JazzCash, bank/Raast transfer, cards, and cash as requested options, but none is represented as available or successful.

## Requested payment methods

| Method | Potential route | CedarBite status |
|---|---|---|
| EasyPaisa | EasyPaisa Online Payment Gateway | Not integrated; merchant approval required |
| JazzCash | JazzCash Online Payment Gateway | Not integrated; merchant approval required |
| Bank transfer | Merchant's bank / Raast P2M | Not integrated; bank must enable merchant acceptance |
| Debit/credit card | Approved acquiring bank/provider hosted checkout | Not integrated; never collect raw card details in CedarBite |
| Cash at counter | Canteen-approved collection workflow | Not enabled; requires operator approval and reconciliation rules |

## Safe activation requirements

1. Obtain written Cedar College and canteen approval for the pilot, data handling, ordering process, and who owns refunds and complaints.
2. Identify the legal merchant that will own the provider account and receive settlement. A student project account must not receive customer funds.
3. Apply to each chosen provider using its official onboarding process. Confirm merchant eligibility, fees, settlement, refund handling, limits, sandbox and production access, and required website policies directly with the provider.
4. Implement a separate provider adapter using its current official API documentation. Use hosted/tokenized checkout for cards; store no card numbers or security codes.
5. Verify transactions server-side through authenticated provider callbacks/status checks. A browser return URL, screenshot, or client-supplied flag must never mark an order paid.
6. Test pending, failed, repeated, expired, reversed, refunded, and settlement-reconciliation cases in sandbox before production credentials are enabled.
7. Store production secrets only in the hosting provider's secret manager. Keep the payment gate closed until the full provider flow is verified.

The current backend deliberately permits payment-gated order API tests only under `CEDARBITE_ENV=test`. Selecting a provider name in development or production does not open checkout. The production-shaped Compose configuration sets `PAYMENT_PROVIDER=none`.

For merchant application steps and official portals, see [merchant-onboarding.md](merchant-onboarding.md).
