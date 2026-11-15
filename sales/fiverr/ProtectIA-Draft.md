# Fiverr offer preparation — ProtectIA

**Status: internal draft, not ready to publish or sell.** The product owner
selected ProtectIA as the commercial name, wants the Aegis faith/reflection
area retained in the same application, and is considering a software licence.
This document does not grant a licence, establish ownership, set a price, or
confirm that Fiverr accepts this type of listing.

## Proposed listing copy (English)

### Title

**I will provide a self-hosted licence for the modular ProtectIA platform**

### Description

ProtectIA is a Portuguese-first, self-hosted web platform for agency
workspaces, account-security controls and digital-care tools. The application
also includes a separate Aegis area for faith, reflection and Bible study.
These are distinct product areas; the Aegis content is not a security feature.

The current codebase includes agency workspaces, OAuth and passkey-based
authentication, session controls, URL indicator lookups, and an assistant
that can use a configured AI provider. Availability depends on configuration
and third-party services.

**Important limitations**

- ProtectIA is not antivirus software, an endpoint agent, or a network
  firewall.
- A URL not found in the configured indicators is not thereby proven safe.
- The risk score is a heuristic placeholder and must not be used to make
  security decisions.
- AI, OAuth, Cloudflare, Stripe, Bible-text, hosting and other third-party
  services may require separate accounts, permissions or fees.
- The codebase has not yet been declared a supported production release.
  Deployment, maintenance and support commitments are not established.

The exact licensed version, permitted use, included files, installation
requirements, support scope and delivery method will be stated before any
purchase is accepted. No rights to resell, redistribute, sublicense or remove
third-party notices are implied.

### Customer requirements to confirm

- Intended use: private/internal, client-facing, or resale.
- Number of deployments and users, if applicable.
- Preferred language and whether the Aegis area should be enabled.
- Hosting environment and who will operate it.
- Required external providers and confirmation that the customer controls
  their own credentials and accounts.

### FAQ copy (draft)

**Does ProtectIA replace antivirus or guarantee that a URL is safe?**  
No. It provides configured indicator lookups and account controls only; it
does not replace antivirus, endpoint detection, a firewall, or a professional
security assessment.

**Are hosting, AI usage and provider accounts included?**  
No inclusion is promised. Any third-party accounts, usage charges, hosting and
operational costs must be agreed explicitly before purchase.

**Can I redistribute or resell the source code?**  
No redistribution or resale right is currently defined. The licence terms must
be agreed and published before a sale.

## Packages and pricing — not set

Do not publish package limits or prices yet. First define and verify:

| Decision | Status |
| --- | --- |
| Licence model and permitted commercial use | Not defined |
| Single deployment vs. multi-deployment rights | Not defined |
| Source-code vs. compiled delivery | Not defined |
| Version included and update entitlement | Not defined |
| Installation, support and maintenance scope | Not defined |
| Package tiers and prices | Not defined |
| Refund, cancellation and delivery terms | Not defined |

## Publication gate

Before publishing this offer:

- [ ] Confirm ownership and authority to license every part of the repository.
- [ ] Review dependency, font, icon, Bible-text, dataset and other third-party
  terms for redistribution and commercial use.
- [ ] Add a repository-wide licence that matches the chosen commercial model;
  do not infer it from the Python package metadata.
- [ ] Define the licence, versioning, permitted use, updates, support, warranty
  disclaimer, refunds and delivery terms with appropriate legal review.
- [ ] Resolve the product identity and document clearly that ProtectIA and
  Aegis are separate areas in one application.
- [ ] Pass the frontend tests, lint and build; run the Python API tests and
  validate a clean Docker installation from documented steps.
- [ ] Establish a supported production configuration, backup/restore process,
  monitoring, incident contact and operational cost model.
- [ ] Replace legal templates with reviewed notices covering actual data
  flows, jurisdictions and subprocessors.
- [ ] Confirm current Fiverr rules for software licences, digital delivery,
  intellectual property and the proposed category before listing.
- [ ] Prepare genuine screenshots and a short demo from the release build;
  do not use fabricated users, outcomes, security claims or testimonials.
- [ ] Set package prices only after estimating support time, infrastructure,
  third-party usage, taxes and marketplace fees.

This draft is a starting point for review, not legal advice or a promise that
the product is ready for commercial deployment.
