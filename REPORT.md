# REPORT (2026-10-15)

Scope: phases 05-10 of `spec/`, **simulator side only**. The SmartOmni platform repo was treated as reference-only (your instruction), so every SmartOmni-side step is written up in `docs/smartomni-requirements/` and marked BLOCKED. Nothing in `spec/00-overview.md` is ticked: reviewers tick. No `.env` or secrets are committed (`.env` is git-ignored; I used a throw-away one and deleted it where I could).

## Phase status (commit = the phase commit on its branch; each was merged into `main` with a `--no-ff` merge commit, so phase boundaries stay visible)

| Phase | Status | Commit | Evidence |
|---|---|---|---|
| 05 Orders, webhooks | PARTIAL (simulator done; SmartOmni steps 6-11 BLOCKED) | `a3b9249` | 25 backend tests (checkout money, validation, idempotency, ON_HOLD rules, cancel-restock once, keyset paging, time boundaries, isolation, Events API, outbox, REORDER/DROP/DUPLICATE, signature on real HTTP + vector, reset); Playwright `phase05-orders.spec.ts` 3/3 |
| 06 Inventory | PARTIAL (SmartOmni debit/outbox/RabbitMQ BLOCKED) | `1acd209` | 19 backend tests incl. concurrency + timeout/app-error faults; 2 frontend tests; Playwright `phase06-inventory.spec.ts` |
| 07a Fulfillment (steps 1-4) | PARTIAL (SmartOmni business API BLOCKED) | `cb6b7cf` | 16 backend tests (ON_HOLD refused, tracking, PDF persists, isolation, PACKAGE_UPDATE); Playwright `phase07a-fulfillment.spec.ts` |
| 07b Returns/cancellations (steps 5-9) | PARTIAL (SmartOmni sync/restock/audit BLOCKED) | `6e622e9` | 15 backend tests (partial return, units/refund limits, concurrency, idempotent approve, window boundary, rma_202604 not served); 2 frontend tests; Playwright `phase07b-aftersale.spec.ts` |
| 08 Conversations | PARTIAL (SmartOmni inbox/AI BLOCKED) | `d535636` | 22 backend tests; 3 frontend tests; Playwright `phase08-chat.spec.ts` |
| 09a Coupons (steps 1-5) | PARTIAL (voucher-lock message in SmartOmni BLOCKED) | `e8ee868` | 16 backend tests (read/filter/page, checkout discount, no double count, creation routes 404); 3 frontend tests; Playwright `phase09a-coupons.spec.ts` |
| 09b Loyalty (steps 6-11) | PARTIAL (all claim/points/tier logic BLOCKED) | `81ccccd` | 3 backend tests (15-day boundary data via the business clock); documented rules in `docs/smartomni-requirements/phase-09.md` |
| 10 Handover | PARTIAL (see "Outstanding") | final commit of this run (see `git log`, prefix `phase-10`) | clean-volume Docker build, Playwright 23/23 x4, contract validator 10/10, README, support matrix, curl/Postman |

Merge commits: `5c392d2` (06), `10ea347` (08), `2814d6d` (07a), `5348392` (09a + coordinator fixes), `3c92303` (07b). Each phase's own "Theo dõi" block is filled in `spec/0N-*.md` (05: by me; the rest by the phase agents; 09b and 10 by me).

## Test results (all run on this machine, Windows, Node 22, Docker 29.8, PostgreSQL 16)

| Gate | Result |
|---|---|
| Simulator backend (`npm test`, embedded PostgreSQL 16) | 13 suites, **202 passed, 0 failed, 0 skipped** (also run twice back to back) |
| Simulator frontend (`npm test`) | 17 passed; typecheck, lint, build clean |
| Backend typecheck / lint / build | clean |
| Contract validator (`node --test contracts/validator/contract.test.ts`) | 10 passed |
| Docker from empty volumes (`docker compose down -v` then `up --build`) | db/api/ui healthy; all 9 Prisma migrations applied; seed ensured |
| Playwright against that stack (`e2e/`, 7 spec files) | **23 passed, 0 skipped**, 4 consecutive runs (one test race in the 07a spec was found and fixed in the test, see below) |
| Persistence (restart `api`, then `db` + `api`) | order + history, webhook job + attempts, chat message, coupon, shipping PDF (same URL), business clock, tokens survive; seed idempotent; logs and HTTP log contain no raw token / app secret |
| Platform repo `mvn -o -B test` (read-only run) | BUILD SUCCESS. integration 78 tests (1 skipped: the live-simulator test, which needs `TIKTOK_SIM_*` env vars), migration-tests 32, plus 5 |
| Platform repo `mvn -o -B clean verify` | BUILD SUCCESS, all 12 modules; includes 7 packaged-service startup tests |

The two `mvn` runs exercise the platform repo's own (uncommitted, earlier-phase) working tree; they say nothing about phases 05-09 because that repo was not changed for them.

## Honest limits (read before relying on any of the above)
- **Everything is `unverified`**: no operation is `supported` in `contracts/manifest.json` (Partner Center pages unreadable). The simulator reproduces the official OAS shapes; transition rules, webhook payloads/`type` numbers (other than ORDER_STATUS_CHANGE = 1), error codes, scope names, hold duration and the return window are simulator choices. See `docs/support-matrix.md`.
- **No SmartOmni-side code was written in this run.** There is no evidence for: webhook receiver verification, order upsert/idempotency/polling checkpoints, inventory debit receipts and outbox, RabbitMQ flow, chat inbox + AI gateway, return/refund sync + restock, claim/points/tiers, voucher-creation lock. The end-to-end chain Buyer -> simulator -> SmartOmni -> inventory is therefore NOT demonstrated.
- **Real AI**: the Python classifier is outside both repos. No AI test exists; any SmartOmni inbox test must use a labelled test double.
- **Real TikTok** was never called.

## BLOCKED items with reproduction / what is needed
| Item | Why | How to reproduce / unblock |
|---|---|---|
| Phase 05 steps 6-11, e2e Buyer -> SmartOmni -> inventory | platform repo is reference-only | implement `docs/smartomni-requirements/phase-05.md` + `phase-06.md` in the platform repo, point it at `http://localhost:8090`, subscribe via `PUT /event/202309/webhooks`, run a Buyer checkout in the UI, then `POST /test-admin/orders/release-due`; watch `/test-admin/webhooks` |
| Phase 06 SmartOmni debit/outbox/RabbitMQ | same | `docs/smartomni-requirements/phase-06.md`; needs `make infra-up` (PostgreSQL/RabbitMQ) in the platform repo |
| Phase 07 steps 4, 8-9 (tracking/label API, sync, error queue) | same | `docs/smartomni-requirements/phase-07.md` |
| Phase 08 steps 5-9 (inbox, AI gateway, complaint lock) | same + Python service external | `docs/smartomni-requirements/phase-08.md` |
| Phase 09 steps 5-11 (voucher lock, Customer Portal claim, points) | same | `docs/smartomni-requirements/phase-09.md`; boundary data: `POST /test-admin/scenarios/loyalty-orders` |
| Phase 10 step 5 (SmartOmni integration tests with real PostgreSQL/RabbitMQ) | depends on the above | run after the SmartOmni side exists |
| Phase 10 step 11 (review SmartOmni migrations) | no SmartOmni migrations were authored here | n/a |

## Outstanding bugs
None known in the simulator. Fixed during this run (see `DECISIONS.md` C1-C4): reset failed once orders existed (FK order); intermittent `ECONNRESET` in the test harness; business clock leaking between test suites; a webhook emitter opening a second DB connection inside a transaction. One Playwright test race (tracking timeline rendered after the status pill) was fixed in the test.

## Decisions you need to review (`DECISIONS.md`)
- **D1** (important): platform repo untouched, SmartOmni work documented as BLOCKED instead of implemented (the brief and your earlier instruction conflicted).
- D2-D8 (orders): one line per unit; transition table; stock reserved at checkout; webhook `type` table; `sim.event.manage`; localhost rewrite; 30-minute hold.
- C1-C4 (coordinator): single scope source, test harness, reset fix, pool/timeout hardening.
- Per-phase tables: Phase 06 (D6.x), 08 (D8.x, notably **D8.2: the API exposes all seeded history, "sync only from connection time" is SmartOmni's job, which departs from the brief**), 07a (D07a-x), 07b (D07b-x, notably: a buyer cancel of a paid AWAITING_SHIPMENT order now needs seller approval; no RETURNED order status exists in the OAS; refund includes shipping on an approved cancellation), 09a (09a-x).

## Housekeeping
- Branches `phase-06`, `phase-07a`, `phase-07b`, `phase-08`, `phase-09a` and local worktrees `../sim-wt-*` exist for traceability; remove the worktrees with `git worktree remove ../sim-wt-06` etc. after review.
- The platform repo is back on its original branch (`feature/docs-github-workflow`) with its own uncommitted work untouched by this run. Earlier in the session (phases 03-04) I had added files there; they remain uncommitted and are not part of this report.
- Tokens issued before a phase added a scope must re-authorize (all new `sim.*` scopes are in `backend/src/oauth/scopes.ts`).

> **Note (later change):** ON_HOLD was removed from the simulator (`docs/remove-on-hold-plan.md`, DECISIONS H1-H13). Rows above that mention ON_HOLD or release-due describe the state at the time they were written.
