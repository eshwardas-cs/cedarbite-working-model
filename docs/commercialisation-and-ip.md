# CedarBite: commercialisation and rights checklist

**Prepared:** 17 November 2026  
**Purpose:** Record what needs to be settled before CedarBite is packaged for another organisation or offered for sale.

This is a project checklist, not a legal opinion or a declaration of ownership. No copyright registration, company formation, commercial licence, or transfer of rights has been completed as part of this document.

## Where the project stands

CedarBite is a student-developed canteen ordering and operations system. The repository contains a web frontend, a Python backend, Netlify functions, Supabase configuration and database material, menu and image assets, and operating documentation. The project is associated with four contributors:

| Contributor | Project role recorded by the team |
|---|---|
| Eshwar Das | Lead Developer |
| Rayan Ahmed | Co-developer |
| Mudassir Munawar Mannan | Co-developer |
| Muhammad Eyad Imran | Co-developer |

The repository does not currently contain a root software licence or a third-party notices file. The README also describes an earlier approval and deployment status. Before sharing a commercial package, reconcile that description with the current facts and the permission actually granted by Cedar College and the canteen.

## Copyright and commercial rights

Pakistan's Copyright Ordinance includes computer programmes within literary works. IPO-Pakistan lists registration for computer programme/software and describes registration as evidence that may help establish ownership. Registration is not a substitute for proving who created or owns each contribution. See the [Copyright Ordinance, 1962](https://pakistancode.gov.pk/pdffiles/administrator5d255d1f44b50b65d6a3e87a2e0d3fee.pdf), [IPO-Pakistan copyright information](https://ipo.gov.pk/copyrights), and its [registration requirements](https://ipo.gov.pk/system/files/Procedure%20for%20Registration%20%28Copyright%29_0.pdf).

Before naming an applicant or placing a copyright notice on the software, the four contributors should sign a written record that answers:

1. Who owns each person's code, writing, designs, and other original contributions?
2. Are the contributions jointly owned, or are rights being assigned to one person or a company?
3. Who may license, sell, modify, or stop distributing CedarBite, and how will revenue and costs be shared?
4. What happens if a contributor leaves or does not agree to a later release?

Do not put all four names under an exclusive commercial copyright claim until everyone has agreed to that arrangement. Keep a truthful contribution history. If AI-assisted work, templates, or outside code were used, record that accurately and check their terms; do not describe the complete codebase as solely human-authored without verifying that claim.

## Cedar College and canteen permission

The General Manager's statement that the team may sell CedarBite in the future is a useful starting point. Before marketing or sale, keep written confirmation of its exact scope. Ask Cedar College and the canteen to confirm whether that permission covers:

- selling or licensing the software to other schools or businesses;
- using the Cedar College/CedarBite names, college logo, campus photographs, and other marks in a product or marketing;
- continued use of the service at Cedar College and responsibility for support;
- ownership and permitted use of menu descriptions, food photographs, prices, and canteen records.

Permission to sell the team's software does not, by itself, transfer ownership of college branding, canteen content, or student information. A commercial edition should be rebranded unless the relevant rights holder gives written permission to use those marks.

## Intended sales model: white-label deployments

The team's intended approach is to offer the same core canteen ordering and staff workflow to other schools under each school's own identity. Each deployment would use that customer's name, logo, domain, menu, email sign-in rules, payment arrangements, and pickup procedures. Cedar College branding and records would stay with the Cedar deployment unless the relevant rights holder separately approves their use.

The customer-facing experience can be substantially the same, but the current code is Cedar-specific and should not be described as ready for multiple schools yet. Before selling a deployment, the product needs a deliberate configuration and isolation review, including:

- configurable school branding and contact details, with no Cedar-only wording embedded in shared screens;
- customer-specific login domains, staff accounts, payment settings, and order rules;
- separate databases or enforced tenant isolation for menus, students, orders, wallet balances, and audit records;
- independent secrets, backups, access controls, retention rules, and privacy terms per school;
- a documented setup process that does not copy one school's real student or canteen data to another.

Treat each school as a separately configured customer deployment until a security review proves that a shared multi-school service safely isolates every customer's records.

## Third-party code, images, and data

Prepare a software bill of materials and a licence notice for every shipped dependency. Include each library's licence and any required attribution or source-code offer. The frontend and backend declare third-party packages; their individual licence terms have not yet been audited for this release.

Create an asset register for the CedarBite logo, menu photographs, illustrations, fonts, and any copied or adapted design material. Record the creator/source, licence or written permission, allowed commercial use, and attribution requirements. Remove or replace anything without a clear commercial-use right.

Never include production credentials, a populated `.env`, private keys, student names or IDs, order history, wallet records, or database exports in a source archive or sales demo. A `.env` file is present in this working folder; it was not opened and must be excluded from all release packages. Provide a blank `.env.example` containing variable names only, after confirming it has no credentials.

Student and staff records are not product assets. A separate commercial deployment needs a clear data controller, lawful purpose, privacy notice, retention schedule, access controls, and written arrangements with each school. Do not copy Cedar College records into another customer's deployment.

## Release package checklist

The package is ready to share commercially only after these items are complete:

- [ ] Signed contributor ownership and revenue/licensing agreement.
- [ ] Written college/canteen permission for the specific commercial and branding uses.
- [ ] Dependency inventory, licence review, and required third-party notices.
- [ ] Asset register with commercial-use rights for every shipped image, logo, font, and illustration.
- [ ] Fresh install and deployment instructions that match the actual release architecture.
- [ ] Database migrations, safe sample data, backup/restore steps, and a clean `.env.example`.
- [ ] Security review covering authentication, staff access, payment handling, and student data.
- [ ] A commercial licence and customer terms prepared for review by a Pakistan-qualified lawyer.
- [ ] IPO-Pakistan software copyright registration application, if the contributors choose to register after ownership is settled.
- [ ] Versioned source archive and release checksum, produced from a clean working tree with secrets, local caches, build leftovers, and private data excluded.

The IPO-Pakistan procedure currently lists two copies of the literary work and a fee of PKR 5,000 for computer programme/software. Its requirements also refer to an originality undertaking and, where applicable, an assignment/NOC from the owner or writer. Fees and filing requirements can change; confirm the current Form-II, evidence, and fee directly with IPO-Pakistan before filing.

## Immediate next decision

The intended sales model is white-label deployment: retain the core product workflow and tailor the identity and operating settings for each school. Before adding a copyright owner name or producing a sale-ready archive, get the four contributors' written agreement on joint ownership versus assignment to a company, and obtain the General Manager's permission in writing with the scope above. Until then, keep CedarBite private and mark any generated archive as an internal working copy, not a commercial release.
