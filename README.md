# SmartOmni TikTok Shop Simulator

Standalone simulator used to test SmartOmni's TikTok Shop features locally. It is **not** part of the SmartOmni Maven reactor and has its own database, volumes, ports and credentials. All data is fake; no real money or real TikTok access is involved.

Status: phases 01-09 are implemented on the simulator side (contracts, foundation, authorization, catalog, orders + webhooks, inventory, fulfillment + returns, conversations, coupons, loyalty test data). SmartOmni-side parts are NOT in this repo: see `docs/smartomni-requirements/`. Nothing is ticked in `spec/00-overview.md` (reviewers tick). Everything is a simulation on contracts that are still `unverified` (see `docs/support-matrix.md`). The implementation plan is in `spec/`.

## What is here

| Path | Purpose |
|---|---|
| `backend/` | NestJS + TypeScript + Prisma API (port 8090) |
| `frontend/` | React + TypeScript + Vite UI (port 3090): Tiptop Shop (buyer), Seller Center, Test Console |
| `docker-compose.yml` | db (internal only), api, ui; named volumes for DB, media and PDF |
| `contracts/`, `docs/` | Owned by Phase 01 (API contracts and documentation) |

### Three separate routers

| Router | Mount | Purpose | Auth |
|---|---|---|---|
| TikTok-shaped public API | root (`/order/...` etc., exact paths from `contracts/`) | What SmartOmni calls. Phase 03: `GET /api/v2/token/get`, `GET /api/v2/token/refresh` (provisional), `GET /authorization/202309/shops`. Phase 04 (read-only, signed, scope `sim.product.read`): `POST /product/202502/products/search` (`page_size` required, opaque `page_token`), `GET /product/202309/products/{product_id}`, `GET /logistics/202309/warehouses`. Unknown paths return a plain 404. | token endpoints: `app_key`+`app_secret` query; shops: `x-tts-access-token` + signed query |
| Demo | `/demo/*` | Seller/Buyer UI scenarios, demo sessions; Phase 04 product writes (`/demo/shops/:id/catalog/*`) and Buyer storefront (`/demo/shops/:id/storefront/*`) | `x-demo-session` (per shop) |
| Test admin | `/test-admin/*` | seed, reset, business clock, faults, webhook replay, logs, status, `catalog/bulk` (generate products for multi-page imports) | `x-test-admin-token` |

Seed, reset, clock and fault control are never reachable through the TikTok router. API fault rules created via `/test-admin/faults` only affect TikTok-router requests.

### Clocks

* **Business clock** (`BusinessClock`): drives business timestamps, adjustable at `/test-admin/clock` (shift, freeze, reset), persisted in the DB.
* **Auth clock** (`AuthClock`): real system time, used for request-signature/timestamp validation and for authorization-code/token expiry. Not adjustable.
* Worker leases and retry scheduling use real system time.

## Run with Docker (recommended)

Requires Docker Desktop / Docker Engine with Compose v2.

```bash
cd smartomni-tiktok-simulator
cp .env.example .env        # then replace every CHANGE_ME value
docker compose up --build -d
docker compose ps           # wait until db, api, ui are healthy
```

* UI: http://localhost:3090 (Test Console at `/console`)
* API: http://localhost:8090 (`/health/live`, `/health/ready`)
* PostgreSQL has no published port; it lives on an internal-only Docker network.
* Ports bind to `127.0.0.1` by default (`BIND_ADDRESS`). For team access, set `BIND_ADDRESS` deliberately and understand that the UI proxy injects the test-admin token for anyone who can reach port 3090.
* The API container applies migrations (`prisma migrate deploy`) and the deterministic seed on start.
* Data survives `docker compose down` / restart (named volumes `tiktok_sim_pgdata`, `tiktok_sim_media`, `tiktok_sim_pdf`). `docker compose down -v` deletes it.
* Reaching SmartOmni on the host from the containers: `HOST_CALLBACK_BASE_URL` (default `http://host.docker.internal`; Linux is covered by `host-gateway`). SmartOmni reaching the simulator uses `PUBLIC_API_BASE_URL` (default `http://localhost:8090`).

## Local development (without Docker for the app)

For a backend-only free deployment using Render and Neon, see [docs/deploy-render-neon.md](docs/deploy-render-neon.md).

Needs Node 20+ and a PostgreSQL 14+ database whose name contains `simulator` (reset safety rail).

```bash
# backend
cd backend
npm ci
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/tiktok_simulator
export TEST_ADMIN_TOKEN=some-local-token
npx prisma migrate deploy
npm run build && npm start          # or: npm run start:dev (tsc watch) in one shell, node dist/main.js in another

# frontend (new shell)
cd frontend
npm ci
TEST_ADMIN_TOKEN=some-local-token npm run dev    # http://localhost:3090, proxies /demo /test-admin /health to :8090
```

### Quality gates

```bash
cd backend  && npm run typecheck && npm run lint && npm run build && npm test
cd frontend && npm run typecheck && npm run lint && npm test && npm run build
```

Backend integration tests need a real PostgreSQL (`FOR UPDATE SKIP LOCKED`). `npm test` starts a throw-away embedded PostgreSQL 16 automatically; set `TEST_DATABASE_URL` (database name must contain `simulator`) to use your own instead.

## Quy trình làm việc với GitHub

Team tích hợp công việc trên `develop`; `main` là nhánh phát hành. Mỗi tính năng hoặc bản sửa lỗi có nhánh riêng từ `develop` và đi qua Pull Request: `feature/*` hoặc `fix/*` → `develop` → `main`. Không đẩy commit trực tiếp lên hai nhánh dùng chung.

Xem [quy trình GitHub](docs/github-workflow.md) để tạo nhánh, kiểm tra, mở PR và phát hành. [CONTRIBUTING.md](CONTRIBUTING.md) ghi quy ước commit và checklist review. Dự án dùng npm trong `backend/` và `frontend/`, không dùng lệnh Maven.

## Frontend (Tiptop Shop UI)

React 18 + Vite, Tailwind CSS v4 and shadcn/ui (`frontend/src/components/ui/`). All UI text is English. Sign-in is the demo sign-in of `/demo/sessions` (no password); the session of each role is kept in `sessionStorage` (`sim.demo-session.BUYER` / `.SELLER`), so a tab can hold a buyer and a seller at the same time.

| Route | Page | Who |
|---|---|---|
| `/` | Home: "Deals on 4★+ products", "Best sellers", search (`?q=`, client-side) | everyone (guests see the mock catalog) |
| `/product/:id` | Product: variants (SKU), quantity, Add to cart / Buy now, ratings and reviews | everyone (real products need a buyer session) |
| `/login` | Sign in as a demo buyer or seller (`?next=` return path, `&role=seller`) | everyone |
| `/cart`, `/checkout` | Cart (optimistic quantities) and checkout with simulated payment | buyer |
| `/account/orders`, `/account/messages` | My orders (tabs, tracking, cancel, return) and chat with the shop | buyer |
| `/seller-center` | Seller Center home: to-do counts, business overview (mock), shop, latest orders | seller |
| `/seller-center/orders`, `/orders/:id` | Manage orders (arrange shipment, print label, simulate carrier, cancel) and order detail | seller |
| `/seller-center/returns`, `/products`, `/vouchers`, `/messages` | Returns & refunds, products + stock history, vouchers, buyer chat | seller |
| `/console` | Test Console (unchanged) | developers |
| `/seller/authorize` | OAuth consent page for SmartOmni (unchanged) | seller |

Buyer-only and seller-only routes send a guest to `/login?next=...`. Links to the removed pages still work: `/buyer/product/<id>` opens `/product/<id>`, other `/buyer/*` paths open `/`, other `/seller/*` paths open `/seller-center`.

Code layout: `src/pages/shop/` (buyer pages), `src/pages/seller-center/`, `src/layouts/` (`ShopLayout`, `SellerLayout`, `LegacyLayout` for the console and consent page), `src/lib/endpoints.ts` (one function per `/demo` endpoint, on top of `api()`), `src/lib/types.ts`, `src/lib/auth.tsx` (`AuthProvider` / `useAuth`). The console still uses `src/styles.css`, loaded in a CSS layer so it cannot leak into the new pages.

### Mock data (`frontend/src/mocks/`)

What the `/demo` API does not provide yet comes from this folder only:

| File | Provides |
|---|---|
| `catalog.ts` | the public catalog shown to guests; mock fields per seeded product (original price, % off, rating, sold, trending, image tile color, category; `seedTitle`/`seedShop` link a mock item to the seeded product and its shop) |
| `enrich.ts` | `enrichProduct(p)`: adds those fields to a real storefront product (by id, then by title, else stable values per id); never changes real title, prices, SKUs or stock |
| `reviews.ts` | rating summary and reviews on the product page |
| `identities.ts` | buyer/seller city on the sign-in page; the preselected buyer (Trần Văn An, or a buyer of the shop selling the mock product in `?next=`) |
| `categories.ts` | the Home "Categories" row (`?category=` filter) |
| `business.ts` | Seller Center "Business overview" numbers |

Mock-driven UI is marked with `MockBadge` (`src/components/ui/mock-badge.tsx`, pink dashed frame + "MOCK"); `DevMock` shows the frame only in development builds. To remove the mocks once the backend has these fields: delete `frontend/src/mocks/`, run `npm run typecheck` in `frontend/`, and replace each import it reports with the real field (or drop the UI that only showed mock data).

### Deploy the frontend to Vercel

The API runs on Render (`render.yaml`, `https://smartomni-tiktok-simulator-api.onrender.com`); Vercel only serves the UI. `frontend/vercel.json` keeps every call same-origin, like nginx in Docker:

| Path | Goes to |
|---|---|
| `/demo/*`, `/health/*` | rewritten straight to the Render API |
| `/test-admin/*` | the Vercel Function `frontend/api/test-admin.ts`, which adds `x-test-admin-token` from its env and forwards method, query and body to `API_ORIGIN/test-admin/...`; status, body, `content-type` and `x-request-id` come back unchanged |
| everything else | `/index.html` (SPA routes) |

1. Vercel: **Add New Project**, import this repository, set **Root Directory** to `frontend`. Framework, build command (`npm run build`) and output (`dist`) come from `vercel.json`.
2. Environment variables (Settings > Environment Variables, then redeploy):

   | Name | Required | Value |
   |---|---|---|
   | `TEST_ADMIN_TOKEN` | yes | the same value as `TEST_ADMIN_TOKEN` of the Render service (Render > Environment). Without it `/test-admin/*` returns 500. |
   | `API_ORIGIN` | no | API base URL for the function; default `https://smartomni-tiktok-simulator-api.onrender.com` |

3. Check: `https://<project>.vercel.app/health/ready` answers, `/` lists products after signing in, and the Test Console (`/console`) loads its status.

Notes:
* Do not prefix these variables with `VITE_`: Vite would put them in the browser bundle. The token is only read by the function at request time.
* The Render URL is written in `vercel.json` (rewrites cannot read env variables). If the API moves, change both `vercel.json` and `API_ORIGIN`.
* Anyone who can open the Vercel site can call `/test-admin/*` through the function (reset, clock, faults), exactly like port 3090 in Docker. Keep the deployment for demos, or protect it with Vercel Deployment Protection.
* The free Render plan sleeps when idle: the first request after a pause can take about a minute.

## API documentation (Swagger / OpenAPI)

All 116 HTTP operations (TikTok-shaped, `/demo`, `/test-admin`, `/health`) are documented in OpenAPI 3.0.3.

* **Swagger UI:** http://localhost:8090/api-docs (after `docker compose up --build -d`, or `npm run build && npm start` in `backend/`)
* **OpenAPI JSON:** http://localhost:8090/api-docs-json, also committed as `docs/openapi.json` (regenerate with `cd backend && npm run build && npm run openapi:export`).
* The UI is served by the API itself, needs no login and is not written to the HTTP log. Use **Authorize** to enter `x-demo-session` or `x-test-admin-token` for `/demo` and `/test-admin` calls.
* TikTok-shaped calls need a computed `sign`, which Swagger UI cannot produce; use `docs/curl-samples.md` or the Postman collection for those.
* The spec is hand-written in `backend/src/openapi/` (routes use zod, not DTO classes). `backend/test/openapi.e2e-spec.ts` fails if a route is added or removed without updating it.

## Data model (Prisma, `backend/prisma/schema.prisma`)

Seller, Shop, Buyer (belongs to one shop), App (fake app key/secret, redirect URIs), Token (SHA-256 hashes only), Warehouse, Product, Sku, InventoryLevel, Scenario, DemoSession (hashed), HttpRequestLog, WebhookJob, WebhookAttempt, FaultRule, ClockState. Later phases add models with **new** migrations only.

### Seed

Deterministic and idempotent: two Vietnamese shops (VND), one seller and separate buyers per shop, products/SKUs, two warehouses each, scenarios. Ids are derived from stable names, so reset + reseed restores the same ids. Inventory is created but never overwritten by a re-run. Triggers: automatically on API start (`SEED_ON_START`), `POST /test-admin/seed`, the Test Console, or `npm run seed` (backend).

### Reset (explicit scope and confirmation)

`POST /test-admin/reset/prepare {scope, shopId?}` returns what will be deleted and a short-lived HMAC confirmation token bound to that scope/shop; `POST /test-admin/reset {scope, shopId?, confirmationToken}` executes it. Scopes: `LOGS`, `WEBHOOKS`, `SHOP` (one shop, then reseeded), `ALL`. The Test Console additionally requires typing `RESET <SCOPE>`. Reset refuses to run unless the connected database name contains `simulator`; it only ever touches the simulator database.

### Webhook worker

PostgreSQL-backed queue (`WebhookJob`/`WebhookAttempt`):

* atomic claim with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`; the attempt row (`STARTED`) is written in the same transaction as the claim, i.e. **before** sending;
* lease (`WEBHOOK_LEASE_MS`); a job whose lease expired (worker crash/restart) is reclaimed, the abandoned attempt becomes `LEASE_EXPIRED`, and the new attempt is flagged `possibleDuplicate`;
* completion is fenced by `leaseToken`; a worker that lost its lease can only record its result as `lateCompletion`;
* exponential backoff (`WEBHOOK_BASE_BACKOFF_MS`, capped), `DEAD` after `maxAttempts`, replay creates a linked new job;
* faults (`HTTP_ERROR`, `DELAY`, `DROP`, `DUPLICATE`) from `/test-admin/faults`; injected duplicates are recorded in `deliveries`.

Webhooks emitted by the simulator are signed and use the TikTok-shaped envelope (see "Orders and webhooks"); ad-hoc test jobs from `/test-admin/webhooks` are unsigned.

### Logging and secrets

Every request (except health probes and console polling reads) is stored in `HttpRequestLog` with `x-request-id`. Tokens, secrets, signatures, authorization headers and session/confirmation tokens are redacted **before** storage (`backend/src/common/redaction.ts`). `.env` is git-ignored; `.env.example` contains placeholders only. The seeded app secret is a fake development value.

## Test Console

Status (DB, worker, clock, queue, seed), Shop & scenario, Reset (two-step), Clock, HTTP log (request-ID filter), Webhooks (history, replay, queue a test event), Faults, plus feature tabs (Orders, Inventory, Fulfillment, Chat, Coupons, Aftersale). Tabs are drop-in files `frontend/src/features/<name>.console.tsx`; every list has loading, error and empty states. The buyer and seller sides of the same features are the Tiptop Shop and Seller Center pages (see Frontend).

## Phase 03: authorization and token lifecycle (simulator side)

Everything below is simulator behaviour built on **unverified** contract material (`contracts/manifest.json`: authorization URL `unsupported`, token endpoints and scopes `unverified`, error codes undocumented). Scope names (`sim.*`), the consent URL, redirect parameter names and error bodies are simulator-defined.

| Step | Where | Notes |
|---|---|---|
| Consent page | UI `http://localhost:3090/seller/authorize?app_key=<key>&state=<state>[&redirect_uri=<registered uri>]` | Demo seller signs in, sees shop + scopes, authorizes or denies. API: `GET/POST /demo/authorization/consent` (`x-demo-session`). |
| Callback | registered redirect URI only (exact match) | `?code=<auth code>&state=<echo>` or `?error=access_denied&state=<echo>`. Codes are single use, TTL `OAUTH_AUTH_CODE_TTL_MS`. |
| Token exchange | `GET /api/v2/token/get?app_key&app_secret&auth_code[&grant_type]` | Envelope `{code:0,message,request_id,data:{access_token,access_token_expire_in,refresh_token,refresh_token_expire_in,open_id}}`. `*_expire_in` are absolute Unix seconds (unconfirmed). |
| Refresh | `GET /api/v2/token/refresh?app_key&app_secret&refresh_token[&grant_type]` | Rotates both tokens; the old refresh token is dead; concurrent use of one refresh token has exactly one winner. |
| Authorized shops | `GET /authorization/202309/shops?app_key&timestamp&sign[&shop_cipher]` + header `x-tts-access-token` | `sign` per `contracts/signing`; timestamp in Unix seconds within `OAUTH_SIGNATURE_WINDOW_MS`. Returns only the token's shop. |
| Test faults | `/test-admin/tokens`, `.../tokens/:id/{expire-access,expire-refresh,revoke,remove-scope}`, `/test-admin/authorization-codes/expire` | Also in the Test Console "Authorization" tab. Metadata only; token values and hashes are never listed. |

Failures return the error-envelope shape `{code:-1,message,request_id,simulator_fault:{kind,...}}`. TikTok error codes are undocumented, so `code` is a simulator sentinel; decide on HTTP status and `simulator_fault.kind`.


## Catalog (Phase 04)

* Product and SKU ids are strings and unique **per shop**: the seed deliberately gives both shops a product `sim-product-shared-1` / SKU `sim-sku-shared-1` with different data, and shop B has two SKUs with the same seller SKU `DUP-1`.
* Search order is a monotonic internal sequence; `page_token` is an opaque cursor over it, so products added during an import appear on a later page and nothing is skipped or repeated. The last page returns `next_page_token: ""`.
* `status` filter values come from the OAS (`ALL`, `DRAFT`, `PENDING`, `FAILED`, `ACTIVATE`, `SELLER_DEACTIVATED`, `PLATFORM_DEACTIVATED`, `FREEZE`, `DELETED`); `ALL` includes every status (whether real TikTok hides `DELETED` under `ALL` is unverified). Unsupported filters are rejected with a 400 test fault, never ignored.
* Prices are strings in VND (`price.sale_price`), per SKU. Warehouse ids (`inventory[].warehouse_id`) match `GET /logistics/202309/warehouses` `id`.
* Product writes exist only as `/demo` endpoints: the contract lists no verified product-write operation.
* Buyer product link: `http://localhost:3090/product/<marketplace product id>` (opens in the buyer session's shop; a product of another shop shows "not available"). Old `/buyer/product/<id>` links redirect there.

## Orders and webhooks (Phase 05)

* Buyer (UI): product page (`/product/<marketplace product id>`) -> cart (`/cart`) -> checkout (`/checkout`, idempotent per `checkoutKey`) -> simulated payment -> My orders (`/account/orders`). Money is computed by the backend per component (product total, seller/platform discount, shipping, tax); the OAS has no line quantity, so each purchased unit is one line item.
* State machine (simulator model, unverified): `UNPAID -> ON_HOLD -> AWAITING_SHIPMENT -> AWAITING_COLLECTION -> IN_TRANSIT -> DELIVERED -> COMPLETED`, `CANCELLED` from the early states. An ON_HOLD order cannot be shipped; DELIVERED is not COMPLETED. The hold lasts `ORDER_HOLD_MINUTES` (30, business clock) and is released by a timer or `POST /test-admin/orders/release-due`.
* Read API: `POST /order/202309/orders/search` (keyset `page_token`, `sort_field`, `sort_order`, filters with `*_ge` inclusive / `*_lt` exclusive) and `GET /order/202507/orders?ids=a,b` (max 50). `recipient_address` is absent for UNPAID/ON_HOLD, as in the OAS.
* Events API: `GET/PUT/DELETE /event/202309/webhooks` (scope `sim.event.manage`). Only subscribed topics are delivered. Emitted topics: `ORDER_STATUS_CHANGE` (type 1), `PACKAGE_UPDATE`, `RETURN_STATUS_CHANGE`, `CANCELLATION_STATUS_CHANGE`, `NEW_MESSAGE`, `NEW_CONVERSATION`; payload fields and numeric `type` values other than 1 are UNVERIFIED.
* Delivery: events are written in the same DB transaction as the state change (outbox), delivered by the worker with retries/backoff and attempt history. Header `Authorization` = lowercase hex `HMAC-SHA256(app_secret, app_key + raw body)` (secondary source). Receivers should dedupe on `tts_notification_id` and reconcile by polling.
* Callback addresses on `localhost`/`127.0.0.1` are rewritten to `HOST_CALLBACK_BASE_URL` inside Docker (`WEBHOOK_REWRITE_LOCALHOST`).
* Faults for events (Test Console Faults tab or `/test-admin/faults`): `DROP`, `DUPLICATE`, `DELAY`, `HTTP_ERROR`, `REORDER` (holds one matching event back so a later one overtakes it; `params.holdMs`). Replay: `/test-admin/webhooks/:id/replay`.

## Other phases in one place

| Phase | Simulator behaviour | Notes |
|---|---|---|
| 06 Inventory | `POST /product/202309/products/{id}/inventory/update` sets ABSOLUTE quantities; per-SKU errors in `data.errors[]`; change log with before/after; faults `TIMEOUT_BEFORE_WRITE`, `TIMEOUT_AFTER_WRITE`, `APP_ERROR_200` | The simulator reserves stock at checkout and restores it once on cancel; it never adds stock on returns. |
| 07a Fulfillment | tracking, package detail, ship package, shipping documents (fake PDF stamped `TEST DATA`, served from `/demo/files/shipping-documents/<token>.pdf`, stored on the PDF volume) | ON_HOLD orders are refused. |
| 07b Aftersale | return search/records/approve/reject, cancellation search/approve/reject, reject reasons, eligibility | Partial returns never change the order status; return window `RETURN_WINDOW_DAYS` (15, business clock) is a test rule; `rma_202604` is not served. |
| 08 Conversations | list/messages/detail/send (TEXT only, 202309), `NEW_MESSAGE`/`NEW_CONVERSATION` events | Send 202606 and image upload return 501. A conversation flag can drop the send response (indeterminate send). |
| 09a Coupons | `POST /promotion/202406/coupons/search`, `GET .../coupons/{id}`; Seller creates coupons only via `/demo`; checkout applies a code to the product subtotal | No create-voucher route exists on the TikTok router (locked). |
| 09b Loyalty data | `POST /test-admin/scenarios/loyalty-orders` creates orders around the 15-day boundary with the business clock | Points and claims are SmartOmni's job. |

## Connecting SmartOmni (only the base URL and credentials change)

| SmartOmni setting | Value for this simulator |
|---|---|
| `TIKTOK_OPEN_API_BASE_URL`, `TIKTOK_TOKEN_BASE_URL` | `http://localhost:8090` |
| `TIKTOK_AUTHORIZATION_URL` | `http://localhost:3090/seller/authorize` |
| `TIKTOK_APP_KEY` / `TIKTOK_APP_SECRET` | `SEED_APP_KEY` / `SEED_APP_SECRET` from your `.env` |
| `TIKTOK_REDIRECT_URI` | must equal one entry of `SEED_APP_REDIRECT_URIS` |
| Webhook address (PUT `/event/202309/webhooks`) | the SmartOmni receiver, for example `http://localhost:8080/...` (localhost is rewritten to the host inside Docker) |
| Scopes | placeholders `sim.*` (see `backend/src/oauth/scopes.ts`); tokens issued before a phase added a scope must re-authorize |

## Browser tests (Playwright)

`e2e/` drives the running Docker stack through the UI (Tiptop Shop checkout, Seller Center, Test Console, chat, coupons, fulfillment, aftersale, restart persistence). Tests sign in through `/login` (`signInAs(page, role, name, next)` in `e2e/tests/helpers.ts`) and reset + re-seed the demo data at the start of each file. It never runs against production.

```bash
docker compose up --build -d      # from the repo root, with a filled-in .env
cd e2e && npm ci && npx playwright install chromium && npx playwright test
```

Set `E2E_UI_URL` / `E2E_API_URL` for non-default ports. `phase10-persistence` signs TikTok-shaped calls with the fake seed secret `fake_app_secret_local`, so the stack's `.env` needs `SEED_APP_SECRET=fake_app_secret_local` for that file; it also restarts the `api` and `db` containers. Screenshots go to `e2e/test-results/shots/` (git-ignored).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `missing_scope` after upgrading | the token was issued before the scope existed: authorize again (consent page) |
| 401 `bad_signature` | sign path + sorted query + the exact raw body (see `contracts/signing/README.md`); `timestamp` must be within `OAUTH_SIGNATURE_WINDOW_MS` of real time (the business clock does not matter) |
| Webhooks never arrive | no subscription for that topic/shop/app (GET `/event/202309/webhooks`), worker disabled (`WEBHOOK_WORKER_ENABLED`), address unreachable from the container, or a `DROP` fault is active |
| Order stuck ON_HOLD | wait `ORDER_HOLD_MINUTES` of business time, or advance the clock and `POST /test-admin/orders/release-due` |
| Reset refuses to run | the database name must contain `simulator` |
| Port in use | change `BIND_ADDRESS` / ports in `.env` and `docker-compose.yml`; UI 3090, API 8090 |
| Tests flake with `ECONNRESET` | use the shared test helpers (`createApp` listens once); do not create a new supertest agent per concurrent request |

## Documents

`docs/support-matrix.md` (implemented / unverified / blocked), `docs/curl-samples.md`, `docs/postman-collection.json`, `docs/smartomni-requirements/` (work that belongs to the SmartOmni repo), `DECISIONS.md` (choices to review), `PROGRESS.md`, `REPORT.md`.
