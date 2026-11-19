# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Standalone simulator of TikTok Shop used to test SmartOmni locally (fake data, own DB, not part of the SmartOmni Maven reactor). Two independent npm packages, no root build: `backend/` (NestJS + Prisma + PostgreSQL, port 8090) and `frontend/` (React 18 + Vite + Tailwind v4 + shadcn/ui, port 3090). `e2e/` holds Playwright tests. Use npm, never Maven. `README.md` is the detailed reference (partly Vietnamese); `AGENTS.md` has repo/commit conventions.

## Commands

Run from inside `backend/` or `frontend/`:

```bash
# backend (needs Node 20+, DATABASE_URL with a db name containing "simulator", TEST_ADMIN_TOKEN)
npm run typecheck && npm run lint && npm run build && npm test
npx jest --config jest.config.js --runInBand test/tiktok-orders.e2e-spec.ts   # single file
npx jest --config jest.config.js --runInBand -t "name pattern"                # single test
npx prisma migrate deploy        # apply migrations (new schema changes = NEW migration, never edit applied ones)
npm run seed                     # after build; npm run openapi:export regenerates docs/openapi.json

# frontend
npm run dev                      # vite on :3090; set TEST_ADMIN_TOKEN, proxies /demo /test-admin /health to :8090
npm run typecheck && npm run lint && npm test && npm run build
npx vitest run src/__tests__/<file>.test.tsx                                   # single test file

# full stack / other
docker compose up --build -d     # db + api + ui (copy .env.example to .env first)
cd e2e && npm test               # Playwright (npm run install:browsers once)
node --experimental-strip-types --test contracts/validator/contract.test.ts   # contract validator (Node >= 22.6)
```

Backend `npm test` boots a throw-away embedded PostgreSQL 16 (`test/global-setup.ts`) unless `TEST_DATABASE_URL` is set (name must contain `simulator`). Tests run serially (`--runInBand`) because they share that DB.

## Architecture (big picture)

**Three routers on one NestJS API**, kept deliberately separate (a router test in `backend/test/routers.e2e-spec.ts` asserts which modules `TiktokModule` may import):
- TikTok-shaped public API at root (`/order/...`, `/api/v2/token/...`, signed requests, `x-tts-access-token`) in `backend/src/tiktok/` — what SmartOmni calls. Paths/shapes come from `contracts/` (snapshots of the official OAS, schemas, fixtures, signing vectors; every operation is still `unverified` in `contracts/manifest.json`).
- `/demo/*` (`backend/src/demo/`) — Seller/Buyer UI endpoints, auth by `x-demo-session` (per shop, hashed in DB).
- `/test-admin/*` — seed, reset, clock, faults, webhook replay, logs; auth by `x-test-admin-token`. Never reachable through the TikTok router.

Domain logic lives in feature modules (`orders`, `fulfillment`, `aftersale`, `chat`, `inventory`, `oauth`, `webhooks`, ...) shared by the routers. Key cross-cutting pieces:
- **Order state machine** `orders/order-state.ts`; fulfillment packages follow it through a transition listener inside the same DB transaction.
- **Inventory**: stock changes write `InventoryChange` rows in the same transaction under row lock; checkout reserves stock, cancel restores it.
- **Webhooks**: PostgreSQL-backed queue (`WebhookJob`/`WebhookAttempt`), claimed with `FOR UPDATE SKIP LOCKED`, lease/fencing tokens, backoff, `DEAD` state, replay. Faults (`HTTP_ERROR`, `DELAY`, `DROP`, `DUPLICATE`, inventory faults) only affect the TikTok router / worker.
- **Two clocks**: `BusinessClock` (adjustable via `/test-admin/clock`, drives business timestamps) vs `AuthClock` (real time, for signature/token expiry). Worker leases use real time.
- **Redaction** (`common/redaction.ts`) strips tokens/secrets before `HttpRequestLog` storage. Reset refuses unless the DB name contains `simulator`.
- **OpenAPI** is hand-written in `backend/src/openapi/` (routes use zod, not DTOs); `test/openapi.e2e-spec.ts` fails if routes change without updating it. Re-export `docs/openapi.json` after route changes.
- `DECISIONS.md` records every deliberate deviation/assumption where the OAS is silent; check it before changing behavior, and add to it for new ones. Specs per phase are in `spec/`; SmartOmni-side requirements in `docs/smartomni-requirements/`.

**Frontend**: routes in `src/App.tsx`; buyer pages `src/pages/shop/`, seller `src/pages/seller-center/`, layouts in `src/layouts/` (`LegacyLayout` for `/console` and `/seller/authorize`). API access is `src/lib/endpoints.ts` (one function per `/demo` endpoint) on top of `api()`. Test Console tabs are drop-in files `src/features/<name>.console.tsx`. Mocks for data the backend lacks live only in `src/mocks/` and are marked with `MockBadge`. In production the UI is served same-origin: nginx in Docker, `frontend/vercel.json` + `frontend/api/test-admin.ts` on Vercel (injects the admin token server-side; never use `VITE_` for it). API deploys to Render (`render.yaml`).

## Git

Conventional Commits with scope (`fix(inventory): ...`). Branches `feature/*`/`fix/*` → `develop` → `main`; never push directly to `develop`/`main`. Stage only files related to the task.

## Workflow (Tiptopshop UI, branch feat/tiptopshop-ui)
- Work one step at a time following docs/tiptopshop-plan.md; never start work belonging to a later step.
- End every step by running, in frontend/: `npm run typecheck && npm run lint && npm test && npm run build`, and report the results (pass/fail + relevant output).
- Never push and never open a PR unless the user asks.

## Constraints
- All UI text in English.
- Data the backend does not provide yet comes from frontend/src/mocks/ (deletable as one folder).
- Keep legacy routes (/buyer, /seller, /console, /seller/authorize) working until Step 13 so existing e2e tests still pass.
- Reuse the existing helpers in frontend/src/lib/ (api(), ApiError, vnd, useAsync, sessionStorage key `sim.demo-session.{ROLE}`) rather than rewriting them.
