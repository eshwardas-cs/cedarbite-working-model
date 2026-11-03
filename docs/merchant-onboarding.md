# Merchant account approval checklist

This checklist is for planning only. CedarBite does not currently have a merchant account or payment integration. The college/canteen must approve the service, and the legal merchant that sells the food must own the merchant relationship and receive settlement funds. Do not use a student's personal account.

## Before applying

1. Get written approval from the Cedar College COO and the canteen operator for an online ordering pilot. Agree who is responsible for orders, cancellations, refunds, complaints, settlement, reconciliation, and student-data handling.
2. Confirm which legal entity is the merchant: the canteen operator or Cedar College. Have that entity's authorized representative make the application and own the settlement bank account.
3. Ask the merchant's bank and each provider for the current eligibility checklist, fees, settlement schedule, refund procedure, transaction limits, and required website policies. The requirements depend on the legal entity and provider; do not assume a student's project team can apply as the merchant.
4. Prepare a public HTTPS website and accurate business information only after the college/canteen approves the name and operational use. Include the privacy, terms, cancellation/refund, contact, and order-fulfilment policies the provider requests.

## EasyPaisa

1. The authorized merchant representative opens the [EasyPaisa Corporate Onboarding Portal](https://registerbusiness.easypaisa.com.pk/) and chooses the Online Payment Gateway option.
2. Submit the merchant and settlement details requested by the portal. Use the legal merchant's information and bank account, not the student's.
3. Ask EasyPaisa for its current sandbox access, integration documentation, production eligibility, fees, settlement timing, refund flow, and webhook/status-verification requirements.
4. Integrate only against its official documentation. The official portal describes its gateway as accepting EasyPaisa or OTC; do not assume it also covers card payments.
5. Complete sandbox testing and provider review. Keep the live payment option disabled until production credentials and server-side transaction verification are issued and tested.

## JazzCash

1. The authorized merchant representative uses the [JazzCash Online Payment onboarding page](https://corporateonboarding.jazzcash.com.pk/online-payment) to start the merchant application and integration process.
2. Request the current document checklist, merchant fees, settlement terms, refund process, production approval requirements, and sandbox credentials.
3. Use the [JazzCash sandbox documentation](https://sandbox.jazzcash.com.pk/SandboxDocumentation/v4.2/index.html) for the selected integration method. Keep credentials on the server, verify payment status with the provider, and never mark an order paid from a browser return alone.
4. Test successful, failed, pending, duplicate, expired, and refunded transactions in sandbox. Get production approval before enabling the method.

## Bank transfer / Raast

1. The merchant asks its bank or payment provider to enable Raast Person-to-Merchant acceptance. The [State Bank of Pakistan's Raast merchant page](https://www.sbp.org.pk/our-subsidiaries/raast/join-raast) says merchants can enable the service through their bank or payment provider.
2. Ask whether the merchant will use a merchant alias, IBAN, QR, request-to-pay, or an API, and how payment confirmation and refunds will be reconciled.
3. Do not treat a student-uploaded screenshot or a client-supplied “paid” flag as confirmation. The order may be marked paid only after the merchant's bank/provider confirms the transaction through an authorized, verifiable process.

## Cards and cash

- For cards, apply through the chosen approved payment provider or acquiring bank. Use its hosted checkout or tokenized flow; CedarBite must never collect or store raw card numbers or security codes.
- Cash at collection is a separate canteen workflow. Get the operator's written approval and agree how staff confirm receipt and reconcile the sale. Until that workflow is implemented and approved, CedarBite leaves cash unavailable too.

## Go-live gate

Before enabling any method, confirm all of the following: written college/canteen pilot approval; merchant ownership and settlement account; approved production credentials; HTTPS domain and provider callback URLs; provider-specific server-side verification; tested refunds and reconciliation; customer-facing policies; access controls; backups; and a named person responsible for incidents. Store credentials in the hosting provider's secret manager, never in source code or the frontend.

Sources: [EasyPaisa corporate onboarding](https://registerbusiness.easypaisa.com.pk/), [JazzCash online payment onboarding](https://corporateonboarding.jazzcash.com.pk/online-payment), [JazzCash sandbox documentation](https://sandbox.jazzcash.com.pk/SandboxDocumentation/v4.2/index.html), and [SBP Raast merchant information](https://www.sbp.org.pk/our-subsidiaries/raast/join-raast).
