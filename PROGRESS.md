# PROGRESS

Working repo: this one (`Smartomni-Tiktok-Simulator`). The SmartOmni platform repo is **reference only** (user instruction); SmartOmni-side work is written as requirement documents in `docs/smartomni-requirements/` and marked BLOCKED here. Nothing in `spec/00-overview.md` is ticked: reviewers tick.

| Phase | Simulator side | SmartOmni side (reference-only repo) | Status |
|---|---|---|---|
| 01 Contracts | done (earlier) | n/a | DRAFT, awaiting review / Partner Center access |
| 02 Foundation | done | n/a | DRAFT, awaiting review |
| 03 Connection | done | done in platform working tree earlier (uncommitted there) | DRAFT |
| 04 Catalog | done | done in platform working tree earlier (uncommitted there) | DRAFT |
| 05 Orders/webhooks | backend + UI done, Playwright 3/3 | BLOCKED (steps 6-11, see docs/smartomni-requirements/phase-05.md) | PARTIAL |
| 06 Inventory/outbox | done (update API, faults, change log, UI) - commit `1acd209` (merged) | BLOCKED (debit receipt, outbox lease, RabbitMQ; docs/smartomni-requirements/phase-06.md) | PARTIAL |
| 07a Fulfillment (steps 1-4) | done (packages, tracking, PDF, ship) - commit `cb6b7cf` (merged) | BLOCKED (business API for tracking/label) | PARTIAL |
| 07b Returns/cancel (steps 5-9) | done (aftersale model, return/cancellation APIs, webhooks, UI) - commit `6e622e9` (merged) | BLOCKED (sync, restock receipt, no manual override, error queue: docs/smartomni-requirements/phase-07.md) | PARTIAL |
| 08 Conversations | done (API, webhooks, chat UI, faults) - commit `d535636` (merged) | BLOCKED (inbox, AI gateway test double, complaint lock) | PARTIAL |
| 09a Coupons (steps 1-5) | done (read API, checkout discount) - commit `e8ee868` (merged) | BLOCKED (voucher lock message, no success email) | PARTIAL |
| 09b Loyalty (steps 6-11) | done: boundary test data via business clock (`/test-admin/scenarios/loyalty-orders`) | BLOCKED (claim, points, tiers: docs/smartomni-requirements/phase-09.md) | PARTIAL |
| 10 Test/handover | done on the simulator side: clean Docker build, Playwright 23/23, README, support matrix, REPORT.md | BLOCKED (steps 5 and 11 need the SmartOmni side) | PARTIAL |
| Product media (docs/product-media-plan.md) | done: seed names, buyers buy from every shop, shared catalog-meta, images in PostgreSQL, `/demo` listing fields, Seller Center product page; Playwright 21/25 locally without Docker (the 4 phase10 restart tests need a running Docker daemon) | n/a | DONE |

## Outstanding
- Everything SmartOmni-side (see the BLOCKED column and `REPORT.md`): the Buyer -> simulator -> SmartOmni -> inventory chain is NOT demonstrated.
- Real AI and real TikTok were never exercised.
- `spec/00-overview.md` checkboxes: reviewers tick.
