import { PathsFragment, arr, bool, int, obj, op, str } from './helpers';

const SEC = ['TestAdminToken'];
const E = 'nest' as const;
const T_SYS = 'Test Admin: System';
const T_DATA = 'Test Admin: Data';
const T_AUTH = 'Test Admin: Auth';
const T_FAULT = 'Test Admin: Faults & Logs';
const T_CHAT = 'Test Admin: Chat';
const T_SCEN = 'Test Admin: Scenarios';

const E401 = 'Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).';
const E400V = 'Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.';
const ruleError400 = 'Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`).';

const dt = (description?: string) => str(description, { format: 'date-time' });
const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const orderStatuses = ['UNPAID', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED'];

const SHOP_ID = '3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11';
const shopIdQuery = { name: 'shopId', description: 'Internal shop id (UUID, the `id` returned by GET /test-admin/shops).', example: SHOP_ID };
const limitQuery = (def: number, max: number) => ({ name: 'limit', description: `Max rows, clamped to [1, ${max}]; non-numeric or 0 falls back to ${def}.`, schema: int(undefined, { default: def, minimum: 1, maximum: max }), example: def });

const clockSnapshot = obj(
  {
    now: str('Business clock now (ISO 8601)'),
    systemNow: str('Real system time (ISO 8601)'),
    offsetMs: { type: 'integer', format: 'int64', description: 'Business clock offset from system time in ms' },
    frozen: bool('True when the business clock is frozen'),
    frozenAt: nullable(str('Frozen instant, or null')),
  },
  ['now', 'systemNow', 'offsetMs', 'frozen', 'frozenAt'],
);
const clockExample = { now: '2026-10-15T08:00:00.000Z', systemNow: '2026-10-15T08:00:00.120Z', offsetMs: 0, frozen: false, frozenAt: null };

const seedSummary = obj({ shops: int(), sellers: int(), buyers: int(), warehouses: int(), products: int(), skus: int(), inventoryLevels: int(), scenarios: int(), apps: int() }, ['shops', 'sellers', 'buyers', 'warehouses', 'products', 'skus', 'inventoryLevels', 'scenarios', 'apps']);
const seedExample = { shops: 2, sellers: 1, buyers: 6, warehouses: 2, products: 12, skus: 30, inventoryLevels: 60, scenarios: 4, apps: 1 };

const resetScope = { type: 'string', enum: ['LOGS', 'WEBHOOKS', 'SHOP', 'ALL'], description: 'What to delete. SHOP deletes one shop and re-seeds its baseline; ALL deletes everything and re-seeds; LOGS = HTTP request logs; WEBHOOKS = webhook jobs and attempts.' };

const tokenView = obj(
  {
    id: str('Token record id'),
    appKey: str(),
    shopId: str('Internal shop id'),
    tiktokShopId: str(),
    shopName: str(),
    scopes: arr(str()),
    status: str('TokenStatus; `ACTIVE` and `REVOKED` appear in the code (full enum is in the prisma schema)'),
    accessExpiresAt: dt(),
    refreshExpiresAt: dt(),
    accessExpired: bool('Evaluated on the auth clock'),
    refreshExpired: bool(),
    revokedAt: nullable(dt()),
    createdAt: dt(),
  },
  ['id', 'appKey', 'shopId', 'tiktokShopId', 'shopName', 'scopes', 'status', 'accessExpiresAt', 'refreshExpiresAt', 'accessExpired', 'refreshExpired', 'revokedAt', 'createdAt'],
  { description: 'Metadata only. Token values and hashes are never returned.' },
);
const tokenExample = { id: '9d6f3c0e-7a41-4c0a-8d8c-1f3b2a5e7c10', appKey: 'smartomni-dev-app', shopId: SHOP_ID, tiktokShopId: '7494000000000001', shopName: 'Shop A', scopes: ['orders.read', 'products.write'], status: 'ACTIVE', accessExpiresAt: '2026-10-15T12:00:00.000Z', refreshExpiresAt: '2026-11-15T08:00:00.000Z', accessExpired: false, refreshExpired: false, revokedAt: null, createdAt: '2026-10-15T08:00:00.000Z' };
const tokenId = { name: 'id', description: 'Token record id (`id` from GET /test-admin/tokens, not a token value).', example: tokenExample.id };

const faultKind = { type: 'string', enum: ['HTTP_ERROR', 'DELAY', 'DROP', 'DUPLICATE', 'REORDER', 'TIMEOUT_BEFORE_WRITE', 'TIMEOUT_AFTER_WRITE', 'APP_ERROR_200'] };
const faultRule = obj(
  {
    id: str(),
    shopId: nullable(str('null = applies to every shop')),
    target: { type: 'string', enum: ['API', 'WEBHOOK'] },
    kind: faultKind,
    pathMatch: nullable(str('API: request path prefix; WEBHOOK: exact topic. null = match all.')),
    params: { type: 'object', additionalProperties: true, description: 'Kind-specific parameters (free-form; keys are read by the fault middleware / webhook worker, not by this endpoint).' },
    remaining: nullable(int('Uses left; null = unlimited. Decremented on each use.')),
    createdAt: dt(),
  },
  ['id', 'shopId', 'target', 'kind', 'pathMatch', 'params', 'remaining', 'createdAt'],
);
const faultExample = { id: 'b6a1f9d2-5c34-4e0e-9f0a-2d9a5f0e8a11', shopId: null, target: 'WEBHOOK', kind: 'DROP', pathMatch: 'ORDER_STATUS_CHANGE', params: {}, remaining: 2, createdAt: '2026-10-15T08:00:00.000Z' };

const webhookAttempt = obj({
  id: str(), jobId: str(), attemptNo: int(), workerId: str(),
  status: { type: 'string', enum: ['STARTED', 'SUCCEEDED', 'FAILED', 'LEASE_EXPIRED'] },
  possibleDuplicate: bool(), lateCompletion: bool(), deliveries: int(),
  startedAt: dt(), finishedAt: nullable(dt()),
  httpStatus: nullable(int()), error: nullable(str()), responseExcerpt: nullable(str()), durationMs: nullable(int()),
});
const webhookJob = obj(
  {
    id: str(), shopId: str(), appId: nullable(str()), topic: str(), payload: { type: 'object', additionalProperties: true }, targetUrl: str(), requestId: nullable(str()),
    status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'DEAD'] },
    attemptCount: int(), maxAttempts: int(), nextAttemptAt: dt(),
    leaseOwner: nullable(str()), leaseToken: nullable(str()), leaseExpiresAt: nullable(dt()),
    lastError: nullable(str()), deliveredAt: nullable(dt()), replayOfId: nullable(str()),
    createdAt: dt(), updatedAt: dt(),
  },
  ['id', 'shopId', 'topic', 'payload', 'targetUrl', 'status', 'attemptCount', 'maxAttempts'],
  { description: 'Raw WebhookJob row (Prisma model, returned unfiltered); the listing additionally includes `attempts`. Further columns, if any, follow the Prisma schema.', additionalProperties: true },
);
const webhookExample = { id: 'c1d2e3f4-0000-4000-8000-000000000001', shopId: SHOP_ID, appId: null, topic: 'ORDER_STATUS_CHANGE', payload: { order_id: '5800000000000001', order_status: 'AWAITING_SHIPMENT' }, targetUrl: 'http://host.docker.internal:8080/webhooks/tiktok', requestId: null, status: 'PENDING', attemptCount: 0, maxAttempts: 5, nextAttemptAt: '2026-10-15T08:00:00.000Z', lastError: null, deliveredAt: null, replayOfId: null };

export const paths: PathsFragment = {
  '/test-admin/status': {
    get: op({
      tag: T_SYS, summary: 'Service status', handler: 'TestAdminController.status', security: SEC, errorShape: E,
      description: 'Reports DB connectivity (`SELECT 1`), the connected database name, webhook worker state, webhook job counts per status, the business clock and a seed summary. If the DB is down, `database.status` is `down`, `webhookJobs` is `{}` and `seed` is null; the call still returns 200.',
      ok: {
        description: 'Status snapshot.',
        schema: obj({
          service: str(), database: obj({ status: { type: 'string', enum: ['up', 'down'] }, name: str('Database name parsed from DATABASE_URL') }),
          worker: obj({ enabled: bool(), running: bool(), workerId: str(), lastTickAt: { nullable: true, description: 'Last worker tick (type decided by WebhookWorkerService; not verified)' }, lastError: { nullable: true, description: 'Last worker error (not verified)' } }),
          webhookJobs: { type: 'object', additionalProperties: int(), description: 'Count per WebhookJobStatus (only statuses that have rows)' },
          clock: clockSnapshot, seed: nullable(seedSummary), publicApiBaseUrl: str(), hostCallbackBaseUrl: str(),
        }),
        example: { service: 'smartomni-tiktok-simulator', database: { status: 'up', name: 'tiktok_simulator' }, worker: { enabled: true, running: true, workerId: 'worker-1-ab12cd34', lastTickAt: null, lastError: null }, webhookJobs: { SUCCEEDED: 4, PENDING: 1 }, clock: clockExample, seed: seedExample, publicApiBaseUrl: 'http://localhost:3000', hostCallbackBaseUrl: 'http://host.docker.internal:8080' },
      },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/seed': {
    post: op({
      tag: T_SYS, summary: 'Run the idempotent seed', handler: 'TestAdminController.runSeed', security: SEC, errorShape: E, status: 201,
      description: 'Upserts the app and clock row and seeds every shop in SEED_SHOPS, then returns row counts. No request body. Safe to repeat (seeding is upsert-based).',
      ok: { description: 'Seed complete (201 Created, Nest default for POST).', schema: obj({ seeded: bool(), summary: seedSummary }, ['seeded', 'summary']), example: { seeded: true, summary: seedExample } },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/reset/prepare': {
    post: op({
      tag: T_SYS, summary: 'Prepare a reset (step 1 of 2)', handler: 'TestAdminController.prepareReset', security: SEC, errorShape: E, status: 201,
      description: 'Dry run: validates the request and returns what would be deleted plus a short-lived HMAC `confirmationToken` bound to scope and shopId (TTL = RESET_CONFIRM_TTL_MS, default 120000 ms). Nothing is deleted. Refuses with 403 unless the connected database name contains "simulator" (case-insensitive).',
      body: { schema: obj({ scope: resetScope, shopId: str('Required for scope SHOP, forbidden for other scopes', { minLength: 1 }) }, ['scope']), example: { scope: 'SHOP', shopId: SHOP_ID } },
      ok: {
        description: 'Reset plan (201 Created).',
        schema: obj({ scope: resetScope, shopId: nullable(str()), description: str(), affects: { type: 'object', additionalProperties: int(), description: 'Row counts per entity that the scope would delete (keys differ per scope)' }, database: str(), confirmationToken: str('`<expiryEpochMs>.<hmac-sha256 hex>`; pass unchanged to POST /test-admin/reset'), expiresAt: dt() }, ['scope', 'shopId', 'description', 'affects', 'database', 'confirmationToken', 'expiresAt']),
        example: { scope: 'LOGS', shopId: null, description: 'Deletes all HTTP request logs. Business data and webhook history are kept.', affects: { httpRequestLogs: 128 }, database: 'tiktok_simulator', confirmationToken: '1792051200000.9b2f0e5d7c...', expiresAt: '2026-10-15T08:02:00.000Z' },
      },
      errors: { 400: `${E400V} Also: \`shopId is required for scope SHOP\`, \`shopId is only allowed for scope SHOP\`, \`Unknown shopId\`.`, 401: E401, 403: 'Database name does not contain "simulator" (`Refusing to reset: ...`).' },
    }),
  },
  '/test-admin/reset': {
    post: op({
      tag: T_SYS, summary: 'Execute a reset (step 2 of 2)', handler: 'TestAdminController.executeReset', security: SEC, errorShape: E, status: 201,
      description: 'Deletes data for the scope and re-seeds (SHOP and ALL). Requires the `confirmationToken` from /test-admin/reset/prepare for the same scope and shopId, unexpired. Same safety rail: 403 if the database name does not contain "simulator". `deleted` reports the counts taken before deletion.',
      body: { schema: obj({ scope: resetScope, shopId: str('Required for SHOP', { minLength: 1 }), confirmationToken: str('Token from prepare', { minLength: 10 }) }, ['scope', 'confirmationToken']), example: { scope: 'LOGS', confirmationToken: '1792051200000.9b2f0e5d7c...' } },
      ok: { description: 'Reset executed (201 Created).', schema: obj({ scope: resetScope, deleted: { type: 'object', additionalProperties: int() } }, ['scope', 'deleted']), example: { scope: 'LOGS', deleted: { httpRequestLogs: 128 } } },
      errors: { 400: `${E400V} Also \`shopId is required for scope SHOP\`.`, 401: E401, 403: 'Not a simulator database; confirmation token malformed (`Invalid confirmation token`), not matching scope/shopId, or expired (`Confirmation token expired; request a new one`).' },
    }),
  },
  '/test-admin/clock': {
    get: op({
      tag: T_SYS, summary: 'Get the business clock', handler: 'TestAdminController.getClock', security: SEC, errorShape: E,
      description: 'Returns the business clock (drives order/aftersale/coupon timestamps). The request-signature clock is separate and not affected.',
      ok: { description: 'Clock snapshot.', schema: clockSnapshot, example: clockExample }, errors: { 401: E401 },
    }),
    put: op({
      tag: T_SYS, summary: 'Set, advance, freeze or reset the business clock', handler: 'TestAdminController.setClock', security: SEC, errorShape: E,
      description: 'Fields are evaluated in this order and only the first present one acts: `reset` (true) > `setTo` (optional `freeze`) > `advanceMs`. With none of them it just returns the snapshot. `advanceMs` moves the frozen instant if frozen, else the offset; negative values pass validation.',
      body: { required: false, schema: obj({ setTo: dt('ISO 8601 datetime'), advanceMs: int('Milliseconds to add (integer; may be negative)'), freeze: bool('Only used with setTo; default false'), reset: bool('true = offset 0 and unfrozen') }), example: { setTo: '2026-11-01T00:00:00.000Z', freeze: true } },
      ok: { description: 'Clock snapshot after the change.', schema: clockSnapshot, example: { ...clockExample, now: '2026-11-01T00:00:00.000Z', frozen: true, frozenAt: '2026-11-01T00:00:00.000Z' } },
      errors: { 400: E400V, 401: E401 },
    }),
  },

  '/test-admin/shops': {
    get: op({
      tag: T_DATA, summary: 'List shops with scenarios and counts', handler: 'TestAdminController.shops', security: SEC, errorShape: E,
      description: 'All shops ordered by name, with their scenarios and row counts. Use `id` as `shopId` in other endpoints. The optional `region` query keeps only shops of that region code (like the toolkit `sandbox shop list --region-code`).',
      query: [{ name: 'region', description: 'Region code filter, e.g. VN. Omitted = every shop.', example: 'VN' }],
      ok: {
        description: 'Shops.',
        schema: obj({ items: arr(obj({ id: str(), tiktokShopId: str(), name: str(), region: str(), currency: str(), status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] }, activeScenarioId: nullable(str()), scenarios: arr(obj({ id: str(), key: str(), name: str(), description: str() })), counts: obj({ products: int(), buyers: int(), webhookJobs: int() }) })) }, ['items']),
        example: { items: [{ id: SHOP_ID, tiktokShopId: '7494000000000001', name: 'Shop A', region: 'VN', currency: 'VND', status: 'ACTIVE', activeScenarioId: null, scenarios: [{ id: 's1', key: 'default', name: 'Default (no faults)', description: 'Baseline behaviour, no injected failures.' }], counts: { products: 6, buyers: 3, webhookJobs: 0 } }] },
      },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/shops/{shopId}/scenario': {
    post: op({
      tag: T_DATA, summary: 'Activate a shop scenario', handler: 'TestAdminController.activateScenario', security: SEC, errorShape: E, status: 201,
      description: 'Sets `activeScenarioId` of the shop to the scenario with the given key. This endpoint only stores the choice; the scenario `config` is consumed elsewhere (the seeded `webhook-flaky-receiver` has `{webhook:{failFirstAttempts:2}}`). Not verified: which component reads it.',
      pathParams: [{ name: 'shopId', description: 'Internal shop id', example: SHOP_ID }],
      body: { schema: obj({ key: str('Scenario key of this shop (seeded: `default`, `webhook-flaky-receiver`)', { minLength: 1 }) }, ['key']), example: { key: 'webhook-flaky-receiver' } },
      ok: { description: 'Scenario activated (201 Created).', schema: obj({ shopId: str(), activeScenarioId: str(), key: str() }, ['shopId', 'activeScenarioId', 'key']), example: { shopId: SHOP_ID, activeScenarioId: 's2', key: 'webhook-flaky-receiver' } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown scenario for this shop (an unknown shopId also lands here, since the lookup is by shop + key).' },
    }),
  },
  '/test-admin/inventory/history': {
    get: op({
      tag: T_DATA, summary: 'Inventory change and update-attempt history', handler: 'TestAdminController.inventoryHistory', security: SEC, errorShape: E,
      description: 'Read-only, newest first (by seq). `shopId` is effectively required: when omitted the handler throws 404 `shopId is required` (404, not 400).',
      query: [{ ...shopIdQuery, required: true }, limitQuery(50, 200)],
      ok: {
        description: 'Changes and attempts.',
        schema: obj({
          changes: arr(obj({ seq: int(), sku: str(), sellerSku: str(), warehouse: str(), warehouseName: str(), before: int(), after: int(), source: str(), noop: bool(), requestId: nullable(str()), note: nullable(str()), at: dt() })),
          attempts: arr(obj({ seq: int(), product: str(), outcome: str(), itemsTotal: int(), itemsApplied: int(), itemsFailed: int(), requestId: nullable(str()), at: dt() })),
        }, ['changes', 'attempts']),
        example: { changes: [{ seq: 3, sku: '7510000000000001', sellerSku: 'A-001', warehouse: '7520000000000001', warehouseName: 'Main', before: 20, after: 15, source: 'ORDER_RESERVE', noop: false, requestId: null, note: null, at: '2026-10-15T08:00:00.000Z' }], attempts: [{ seq: 1, product: '7500000000000001', outcome: 'SUCCESS', itemsTotal: 1, itemsApplied: 1, itemsFailed: 0, requestId: 'req-1', at: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { 401: E401, 404: '`shopId is required` (missing query parameter).' },
    }),
  },
  '/test-admin/coupons': {
    get: op({
      tag: T_DATA, summary: 'Coupon overview', handler: 'TestAdminController.listCoupons', security: SEC, errorShape: E,
      description: 'Read-only list of coupons (oldest first by seq), optionally for one shop and/or one code batch, in pages of `limit` (default 200, 1..500). Pass the `next` of a page as `after` to get the following page; `next` is empty on the last page. `status` is computed on the business clock: DEACTIVATED, NOT_START, EXPIRED or ONGOING. `usages` lists the orders that used the coupon: this order <-> code link exists only on /test-admin, never on the TikTok router (Order Detail has no coupon field).',
      query: [
        shopIdQuery,
        { name: 'batchId', description: 'Only the codes of this batch (`batchId` of a code, or `id` of a /demo coupon batch).', example: '0b6f1c2e-4d7a-4f0e-9a51-2c3d4e5f6a7b' },
        { name: 'after', description: 'Cursor: the `next` value of the previous page.', example: '120' },
        { name: 'limit', description: 'Page size 1..500 (default 200); anything else answers 400.', schema: int(undefined, { default: 200, minimum: 1, maximum: 500 }), example: 200 },
      ],
      ok: {
        description: 'Coupons.',
        schema: obj({
          items: arr(obj({
            id: str('Coupon external id'), title: str(), promoCode: str('Promo code (nullability not verified)'), status: { type: 'string', enum: ['DEACTIVATED', 'NOT_START', 'EXPIRED', 'ONGOING'] }, redeemedCount: int(), redemptionLimit: nullable(int()), startAt: dt(), endAt: dt(),
            batchId: nullable(str('Batch of single-use codes; null for a single voucher')),
            usages: arr(obj({ orderId: str('Order external id'), discountVnd: int(), at: dt() })),
          })),
          next: str('Cursor for the next page; empty string on the last page'),
        }, ['items', 'next']),
        example: { items: [{ id: '7600000000000001', title: 'Loyalty Diamond 30%', promoCode: 'K7M2QX9PRT', status: 'ONGOING', redeemedCount: 1, redemptionLimit: 1, startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-12-31T00:00:00.000Z', batchId: '0b6f1c2e-4d7a-4f0e-9a51-2c3d4e5f6a7b', usages: [{ orderId: '5800000000000001', discountVnd: 77400, at: '2026-10-02T08:00:00.000Z' }] }], next: '' },
      },
      errors: { 400: '`limit` not an integer in 1..500, or `after` not a valid cursor.', 401: E401 },
    }),
  },
  '/test-admin/aftersale': {
    get: op({
      tag: T_DATA, summary: 'List aftersale requests', handler: 'TestAdminController.listAftersale', security: SEC, errorShape: E,
      description: 'Cancellations and returns, newest first.',
      query: [shopIdQuery, limitQuery(50, 200)],
      ok: {
        description: 'Aftersale requests.',
        schema: obj({ items: arr(obj({ id: str('External id'), shopId: str(), shopName: str(), orderId: str('Order external id'), kind: { type: 'string', enum: ['CANCELLATION', 'RETURN'] }, type: str('Request type as stored (for returns REFUND or RETURN_AND_REFUND)'), status: str('e.g. CANCELLATION_REQUEST_PENDING, CANCELLATION_REQUEST_SUCCESS, RETURN_OR_REFUND_REQUEST_PENDING, AWAITING_BUYER_SHIP, RETURN_OR_REFUND_REQUEST_COMPLETE'), units: int('Number of aftersale lines'), refundTotalVnd: int(), updatedAt: dt() })) }, ['items']),
        example: { items: [{ id: '7700000000000001', shopId: SHOP_ID, shopName: 'Shop A', orderId: '5800000000000001', kind: 'RETURN', type: 'REFUND', status: 'RETURN_OR_REFUND_REQUEST_SUCCESS', units: 1, refundTotalVnd: 45000, updatedAt: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/aftersale/{ref}/records': {
    get: op({
      tag: T_DATA, summary: 'Status history of one aftersale request', handler: 'TestAdminController.aftersaleRecords', security: SEC, errorShape: E,
      description: 'Looks up the request by row id or external id (pass `shopId` when the external id could exist in several shops) and returns its transition records oldest first.',
      pathParams: [{ name: 'ref', description: 'Aftersale row id or external id', example: '7700000000000001' }], query: [shopIdQuery],
      ok: {
        description: 'Records.',
        schema: obj({ id: str(), status: str(), records: arr(obj({ from: str(), to: str(), actor: str(), note: str(), at: dt() })) }, ['id', 'status', 'records']),
        example: { id: '7700000000000001', status: 'RETURN_OR_REFUND_REQUEST_SUCCESS', records: [{ from: 'RETURN_OR_REFUND_REQUEST_PENDING', to: 'RETURN_OR_REFUND_REQUEST_SUCCESS', actor: 'SELLER', note: 'approved', at: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { 400: 'Aftersale id is ambiguous across shops; pass `shopId`.', 401: E401, 404: 'Unknown aftersale request.' },
    }),
  },
  '/test-admin/aftersale/{ref}/complete': {
    post: op({
      tag: T_DATA, summary: 'Mark the refund as paid out (SUCCESS to COMPLETE)', handler: 'TestAdminController.completeAftersale', security: SEC, errorShape: E, status: 201,
      description: 'Moves a request from CANCELLATION_REQUEST_SUCCESS to CANCELLATION_REQUEST_COMPLETE (cancellation) or from RETURN_OR_REFUND_REQUEST_SUCCESS to RETURN_OR_REFUND_REQUEST_COMPLETE (return). A request that is already complete is returned as is (idempotent). From any other status it is refused with 400 `invalid_decision`. No body.',
      pathParams: [{ name: 'ref', description: 'Aftersale row id or external id', example: '7700000000000001' }], query: [shopIdQuery],
      ok: { description: 'Resulting request (201 Created).', schema: obj({ id: str(), status: str() }, ['id', 'status']), example: { id: '7700000000000001', status: 'RETURN_OR_REFUND_REQUEST_COMPLETE' } },
      errors: { 400: `Id ambiguous across shops, or ${ruleError400} Code \`invalid_decision\`: the request is not in the SUCCESS status.`, 401: E401, 404: 'Unknown aftersale request.' },
    }),
  },
  '/test-admin/orders': {
    get: op({
      tag: T_DATA, summary: 'List orders', handler: 'TestAdminController.listOrders', security: SEC, errorShape: E,
      description: 'Newest first (by seq). `status` is used in the query unvalidated; an unknown value simply returns no rows.',
      query: [shopIdQuery, { name: 'status', description: 'Order status filter', schema: { type: 'string', enum: orderStatuses }, example: 'AWAITING_SHIPMENT' }, limitQuery(50, 200), { name: 'pageSize', description: 'Toolkit-style page size, clamped to [1, 10]; when sent it wins over `limit`.', schema: int(undefined, { minimum: 1, maximum: 10 }), example: 10 }],
      ok: {
        description: 'Orders.',
        schema: obj({ items: arr(obj({ id: str('Order external id'), rowId: str('Internal row id'), shopId: str(), shopName: str(), buyerName: str(), status: str(), canonical_status: str('Toolkit canonical state: the status, or CANCEL_PENDING for AWAITING_SHIPMENT with a buyer cancel request'), units: int('Number of order lines (one per unit)'), createdAt: dt(), updatedAt: dt() })) }, ['items']),
        example: { items: [{ id: '5800000000000001', rowId: 'a0b1c2d3-0000-4000-8000-000000000001', shopId: SHOP_ID, shopName: 'Shop A', buyerName: 'Nguyen Van A', status: 'AWAITING_SHIPMENT', canonical_status: 'AWAITING_SHIPMENT', units: 2, createdAt: '2026-10-15T08:00:00.000Z', updatedAt: '2026-10-15T08:00:05.000Z' }] },
      },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/orders/{ref}/audit': {
    get: op({
      tag: T_DATA, summary: 'Status history of one order', handler: 'TestAdminController.orderAudit', security: SEC, errorShape: E,
      description: 'Looks up an order by row id or external id (add `shopId` if the external id exists in several shops) and returns its audit rows oldest first.',
      pathParams: [{ name: 'ref', description: 'Order row id or external id', example: '5800000000000001' }], query: [shopIdQuery],
      ok: {
        description: 'Audit history.',
        schema: obj({ orderId: str(), status: str(), history: arr(obj({ from: nullable(str()), to: str(), actor: str('e.g. TEST_CONSOLE, SYSTEM, SELLER, BUYER'), note: nullable(str()), at: dt() })) }, ['orderId', 'status', 'history']),
        example: { orderId: '5800000000000001', status: 'AWAITING_SHIPMENT', history: [{ from: 'UNPAID', to: 'AWAITING_SHIPMENT', actor: 'BUYER', note: 'fake payment', at: '2026-10-15T08:00:05.000Z' }] },
      },
      errors: { 400: 'Order id is ambiguous across shops; pass `shopId`.', 401: E401, 404: 'Unknown order.' },
    }),
  },
  '/test-admin/orders/{ref}/transition': {
    post: op({
      tag: T_DATA, summary: 'Force an order status transition', handler: 'TestAdminController.transitionOrder', security: SEC, errorShape: E, status: 201,
      description: 'Runs the same state machine the apps use (actor `TEST_CONSOLE`). Allowed: UNPAID to AWAITING_SHIPMENT or CANCELLED; AWAITING_SHIPMENT to PARTIALLY_SHIPPING, AWAITING_COLLECTION or CANCELLED; PARTIALLY_SHIPPING to AWAITING_COLLECTION; AWAITING_COLLECTION to IN_TRANSIT (an order can no longer be cancelled once shipment is arranged); IN_TRANSIT to DELIVERED; DELIVERED to COMPLETED; COMPLETED and CANCELLED are terminal. Cancelling releases reserved stock; other side effects (events) happen inside the order service.',
      pathParams: [{ name: 'ref', description: 'Order row id or external id', example: '5800000000000001' }],
      body: { schema: obj({ to: { type: 'string', enum: orderStatuses, description: 'Target status. OPTIONAL: when omitted the order moves ONE happy-path step (UNPAID pays, AWAITING_SHIPMENT arranges the package, AWAITING_COLLECTION and IN_TRANSIT advance the carrier, DELIVERED completes); a COMPLETED or CANCELLED order stays and `transitioned` is false.' }, shopId: str('Disambiguates the order ref across shops', { minLength: 1 }), note: str('Audit note (max 300); default `test console`', { maxLength: 300 }), cancelReason: str('Used when to=CANCELLED (max 300); falls back to note', { maxLength: 300 }) }), example: { to: 'CANCELLED', cancelReason: 'out of stock' } },
      ok: { description: 'Transition applied (201 Created).', schema: obj({ id: str(), from: str(), status: str(), before_status: str('Canonical state before'), after_status: str('Canonical state after'), transitioned: bool('false when nothing changed (terminal order)'), updatedAt: dt() }, ['id', 'from', 'status', 'before_status', 'after_status', 'transitioned', 'updatedAt']), example: { id: '5800000000000001', from: 'UNPAID', status: 'AWAITING_SHIPMENT', before_status: 'UNPAID', after_status: 'AWAITING_SHIPMENT', transitioned: true, updatedAt: '2026-10-15T08:06:00.000Z' } },
      errors: { 400: `${E400V} Also order id ambiguous across shops, or ${ruleError400} Code \`invalid_transition\`, e.g. \`UNPAID -> AWAITING_COLLECTION is not allowed (an UNPAID order cannot be shipped)\`.`, 401: E401, 404: 'Unknown order.', 409: 'The order changed concurrently; retry.' },
    }),
  },
  '/test-admin/sandbox/products': {
    get: op({
      tag: T_DATA, summary: 'Sandbox product list (toolkit shape)', handler: 'SandboxAdminController.products', security: SEC, errorShape: E,
      description: 'Counterpart of `sandbox product list`: ACTIVATE products with NORMAL SKUs; `stock_count` is the stock summed over the warehouses. `limits` are the simulator caps for Create Sandbox Order.',
      query: [{ ...shopIdQuery, required: true }],
      ok: { description: 'Products.', schema: obj({ shop_id: str(), products: arr(obj({ product_id: str(), title: str(), sku_list: arr(obj({ id: str(), seller_sku: str(), price: int(), stock_count: int() })) })), limits: obj({ max_quantity_per_sku: int(), max_order_count: int() }) }, ['products', 'limits']), example: { shop_id: '7494000000000001', products: [{ product_id: '7500000000000001', title: 'Tote bag', sku_list: [{ id: '7510000000000001', seller_sku: 'BAG-NAT', price: 120000, stock_count: 40 }] }], limits: { max_quantity_per_sku: 20, max_order_count: 10 } } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown shop.' },
    }),
  },
  '/test-admin/sandbox/orders': {
    post: op({
      tag: T_DATA, summary: 'Create sandbox orders (batch)', handler: 'SandboxAdminController.createOrders', security: SEC, errorShape: E, status: 201,
      description: 'Counterpart of `sandbox order create`: places `order_count` orders through the real checkout (own checkoutKey each) and pays them unless `pay` is false. A batch can be partly created and partly failed; created orders are never rolled back. Uses the first buyer of the shop (or the first marketplace buyer).',
      body: { schema: obj({ shopId: str('Internal shop id', { minLength: 1 }), items: arr(obj({ product_id: str('Optional, informational'), sku_id: str('SKU external id'), quantity: int(undefined, { minimum: 1, maximum: 20 }) })), order_count: int(undefined, { minimum: 1, maximum: 10, default: 1 }), logistics_service_id: str('Optional; one of the simulator delivery option ids'), payment_method: str('Optional label stored as the order payment method name'), pay: bool('Default true: pay after checkout (the order becomes AWAITING_SHIPMENT)') }, ['shopId', 'items']), example: { shopId: SHOP_ID, items: [{ sku_id: '7510000000000001', quantity: 1 }], order_count: 2 } },
      ok: { description: 'Batch result (201 Created).', schema: obj({ created: arr(obj({ order_id: str(), status: str() })), failed: arr(obj({ index: int(), error: str() })), request_id: nullable(str()) }, ['created', 'failed']), example: { created: [{ order_id: '5800000000000001', status: 'AWAITING_SHIPMENT' }], failed: [], request_id: null } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown shop, or the shop has no buyer.' },
    }),
  },
  '/test-admin/catalog/bulk': {
    post: op({
      tag: T_DATA, summary: 'Generate bulk products', handler: 'TestAdminController.bulkProducts', security: SEC, errorShape: E, status: 201,
      description: 'Creates `count` ACTIVATE products titled `Bulk <batch> #n`, each with `skusPerProduct` priced SKUs (20000 to 69000 VND) and 10-29 units of stock in every warehouse of the shop. Fake data for multi-page import tests; products are created one by one (not in one transaction).',
      body: { schema: obj({ shopId: str('Internal shop id', { minLength: 1 }), count: int('Products to create', { minimum: 1, maximum: 500 }), skusPerProduct: int('SKUs per product', { minimum: 1, maximum: 5, default: 2 }) }, ['shopId', 'count']), example: { shopId: SHOP_ID, count: 50, skusPerProduct: 2 } },
      ok: { description: 'Created (201 Created).', schema: obj({ shopId: str(), created: int(), skusPerProduct: int(), totalProducts: int('All products of the shop after the call') }, ['shopId', 'created', 'skusPerProduct', 'totalProducts']), example: { shopId: SHOP_ID, created: 50, skusPerProduct: 2, totalProducts: 56 } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown shop.' },
    }),
  },

  '/test-admin/tokens': {
    get: op({
      tag: T_AUTH, summary: 'List token records (metadata only)', handler: 'TestAdminController.listTokens', security: SEC, errorShape: E,
      description: 'Newest first. Never returns token values or hashes. Expiry flags use the auth clock.',
      query: [shopIdQuery],
      ok: { description: 'Tokens.', schema: obj({ items: arr(tokenView) }, ['items']), example: { items: [tokenExample] } },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/tokens/{id}/expire-access': {
    post: op({
      tag: T_AUTH, summary: 'Expire the access token', handler: 'TestAdminController.expireAccess', security: SEC, errorShape: E, status: 201,
      description: 'Sets `accessExpiresAt` one second before the auth clock now, so the normal expiry path (not a special status) is exercised. The refresh token stays valid. No body.',
      pathParams: [tokenId], ok: { description: 'Updated token view (201 Created).', schema: tokenView, example: { ...tokenExample, accessExpiresAt: '2026-10-15T07:59:59.000Z', accessExpired: true } },
      errors: { 401: E401, 404: 'Unknown token record.' },
    }),
  },
  '/test-admin/tokens/{id}/expire-refresh': {
    post: op({
      tag: T_AUTH, summary: 'Expire the refresh token', handler: 'TestAdminController.expireRefresh', security: SEC, errorShape: E, status: 201,
      description: 'Sets `refreshExpiresAt` one second before the auth clock now. No body.',
      pathParams: [tokenId], ok: { description: 'Updated token view (201 Created).', schema: tokenView, example: { ...tokenExample, refreshExpiresAt: '2026-10-15T07:59:59.000Z', refreshExpired: true } },
      errors: { 401: E401, 404: 'Unknown token record.' },
    }),
  },
  '/test-admin/tokens/{id}/revoke': {
    post: op({
      tag: T_AUTH, summary: 'Revoke a token (seller revoked the app)', handler: 'TestAdminController.revokeToken', security: SEC, errorShape: E, status: 201,
      description: 'Sets status REVOKED and `revokedAt`; both tokens stop working immediately. This endpoint does not send a SELLER_DEAUTHORIZATION webhook (the code comment says that belongs to another phase). No body.',
      pathParams: [tokenId], ok: { description: 'Updated token view (201 Created).', schema: tokenView, example: { ...tokenExample, status: 'REVOKED', revokedAt: '2026-10-15T08:00:00.000Z' } },
      errors: { 401: E401, 404: 'Unknown token record.' },
    }),
  },
  '/test-admin/tokens/{id}/remove-scope': {
    post: op({
      tag: T_AUTH, summary: 'Remove one granted scope from a token', handler: 'TestAdminController.removeScope', security: SEC, errorShape: E, status: 201,
      description: 'Removes the scope from this token only (not from the app, so a re-seed does not undo it). Used to test missing-scope handling.',
      pathParams: [tokenId],
      body: { schema: obj({ scope: str('Scope the token currently holds', { minLength: 1, maxLength: 200 }) }, ['scope']), example: { scope: 'products.write' } },
      ok: { description: 'Updated token view (201 Created).', schema: tokenView, example: { ...tokenExample, scopes: ['orders.read'] } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown token record, or `The token does not hold that scope`.' },
    }),
  },
  '/test-admin/authorization-codes/expire': {
    post: op({
      tag: T_AUTH, summary: 'Expire all unused authorization codes', handler: 'TestAdminController.expireCodes', security: SEC, errorShape: E, status: 201,
      description: 'Marks every not yet consumed and not yet expired authorization code (of one shop, or of all shops when `shopId` is omitted) as expired one second ago, to test "code expired" end to end.',
      body: { required: false, schema: obj({ shopId: str('Limit to one shop (internal id)', { minLength: 1 }) }), example: { shopId: SHOP_ID } },
      ok: { description: 'Number of codes expired (201 Created).', schema: obj({ expired: int() }, ['expired']), example: { expired: 1 } },
      errors: { 400: E400V, 401: E401 },
    }),
  },

  '/test-admin/faults': {
    get: op({
      tag: T_FAULT, summary: 'List fault rules', handler: 'TestAdminController.listFaults', security: SEC, errorShape: E,
      description: 'Oldest first. With `shopId`, returns rules for that shop plus global rules (`shopId` null); without it, all rules.',
      query: [shopIdQuery],
      ok: { description: 'Fault rules.', schema: obj({ items: arr(faultRule) }, ['items']), example: { items: [faultExample] } },
      errors: { 401: E401 },
    }),
    post: op({
      tag: T_FAULT, summary: 'Create a fault rule', handler: 'TestAdminController.createFault', security: SEC, errorShape: E, status: 201,
      description: 'Rules are consumed by the TikTok-router middleware (target API; pathMatch is a path prefix), the webhook worker (target WEBHOOK; pathMatch is the exact topic) and, for TIMEOUT_BEFORE_WRITE, TIMEOUT_AFTER_WRITE and APP_ERROR_200, only by the inventory update handler. REORDER applies when an event is enqueued, not at delivery. `params` is stored as given; its keys per kind are defined in the middleware/worker and are not validated here, nor is target/kind compatibility. An unknown non-null `shopId` fails at the database (foreign key) and this handler does not map it to a 4xx (not verified).',
      body: {
        schema: obj({
          shopId: nullable(str('null/omitted = all shops', { minLength: 1 })),
          target: { type: 'string', enum: ['API', 'WEBHOOK'] },
          kind: faultKind,
          pathMatch: nullable(str(undefined, { minLength: 1 })),
          params: { type: 'object', additionalProperties: true },
          remaining: nullable(int('Number of uses; null/omitted = unlimited', { minimum: 1 })),
        }, ['target', 'kind']),
        example: { shopId: null, target: 'WEBHOOK', kind: 'DROP', pathMatch: 'ORDER_STATUS_CHANGE', remaining: 2 },
      },
      ok: { description: 'Created rule (201 Created).', schema: faultRule, example: faultExample },
      errors: { 400: E400V, 401: E401 },
    }),
  },
  '/test-admin/faults/{id}': {
    delete: op({
      tag: T_FAULT, summary: 'Delete a fault rule', handler: 'TestAdminController.removeFault', security: SEC, errorShape: E,
      description: 'Idempotent: uses deleteMany, so an unknown id still returns `{deleted: true}` (no 404).',
      pathParams: [{ name: 'id', description: 'Fault rule id', example: faultExample.id }],
      ok: { description: 'Always `{deleted: true}`.', schema: obj({ deleted: bool() }, ['deleted']), example: { deleted: true } },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/http-logs': {
    get: op({
      tag: T_FAULT, summary: 'Query HTTP request logs', handler: 'TestAdminController.httpLogs', security: SEC, errorShape: E,
      description: 'Rows of the request log (newest first). Filters are exact matches combined with AND. Rows are returned as stored; redaction, if any, happens when they are written (not verified here).',
      query: [{ name: 'requestId', description: 'Exact request id (the `request_id` of a response)', example: 'req-9d1c' }, shopIdQuery, { name: 'router', description: 'Router label stored with the log row (set by the logging middleware; values not verified)', example: 'tiktok' }, limitQuery(100, 500)],
      ok: {
        description: 'Log rows.',
        schema: obj({ items: arr(obj({ id: str(), requestId: str(), router: str(), method: str(), path: str(), query: { nullable: true, description: 'JSON' }, requestHeaders: { nullable: true, description: 'JSON' }, requestBody: nullable(str()), responseStatus: int(), responseHeaders: { nullable: true, description: 'JSON' }, responseBody: nullable(str()), durationMs: int(), shopId: nullable(str()), createdAt: dt() })) }, ['items']),
        example: { items: [{ id: 'l1', requestId: 'req-9d1c', router: 'tiktok', method: 'GET', path: '/order/202309/orders', query: { page_size: '10' }, requestHeaders: null, requestBody: null, responseStatus: 200, responseHeaders: null, responseBody: '{"code":0}', durationMs: 12, shopId: SHOP_ID, createdAt: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { 401: E401 },
    }),
  },
  '/test-admin/webhooks': {
    get: op({
      tag: T_FAULT, summary: 'List webhook jobs with attempts', handler: 'TestAdminController.listWebhooks', security: SEC, errorShape: E,
      description: 'Newest first, each with its delivery `attempts` ordered by attemptNo. `status` is cast without validation; an invalid value is rejected by Prisma and would surface as a 500 (the handler does not map it).',
      query: [{ name: 'requestId', description: 'Request id that caused the event', example: 'req-9d1c' }, shopIdQuery, { name: 'status', description: 'Job status', schema: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'DEAD'] }, example: 'DEAD' }, limitQuery(50, 200)],
      ok: { description: 'Jobs.', schema: obj({ items: arr({ allOf: [webhookJob, obj({ attempts: arr(webhookAttempt) })] }) }, ['items']), example: { items: [{ ...webhookExample, status: 'SUCCEEDED', attemptCount: 1, attempts: [{ id: 'at1', jobId: webhookExample.id, attemptNo: 1, workerId: 'worker-1-ab12cd34', status: 'SUCCEEDED', possibleDuplicate: false, lateCompletion: false, deliveries: 1, startedAt: '2026-10-15T08:00:01.000Z', finishedAt: '2026-10-15T08:00:01.050Z', httpStatus: 200, error: null, responseExcerpt: 'ok', durationMs: 50 }] }] } },
      errors: { 401: E401 },
    }),
    post: op({
      tag: T_FAULT, summary: 'Enqueue a webhook delivery', handler: 'TestAdminController.enqueueWebhook', security: SEC, errorShape: E, status: 201,
      description: 'Creates a PENDING job for the worker to deliver to `targetUrl` (retried up to `maxAttempts`, default 5, with backoff). The payload is stored as given; how the worker wraps or signs it is not verified here.',
      body: { schema: obj({ shopId: str('Internal shop id', { minLength: 1 }), topic: str('Event topic', { minLength: 1, maxLength: 100 }), payload: { type: 'object', additionalProperties: true }, targetUrl: str('http(s) URL', { format: 'uri' }), maxAttempts: int(undefined, { minimum: 1, maximum: 20, default: 5 }) }, ['shopId', 'topic', 'payload', 'targetUrl']), example: { shopId: SHOP_ID, topic: 'ORDER_STATUS_CHANGE', payload: { order_id: '5800000000000001', order_status: 'AWAITING_SHIPMENT' }, targetUrl: 'http://host.docker.internal:8080/webhooks/tiktok', maxAttempts: 3 } },
      ok: { description: 'Created job (201 Created).', schema: webhookJob, example: webhookExample },
      errors: { 400: E400V, 401: E401, 404: 'Unknown shop.' },
    }),
  },
  '/test-admin/webhooks/{jobId}/replay': {
    post: op({
      tag: T_FAULT, summary: 'Replay a webhook job', handler: 'TestAdminController.replayWebhook', security: SEC, errorShape: E, status: 201,
      description: 'Enqueues a new PENDING job copying shop, topic, payload, target URL and maxAttempts from the original, with `replayOfId` set. The original job is untouched. No body.',
      pathParams: [{ name: 'jobId', description: 'Webhook job id', example: webhookExample.id }],
      ok: { description: 'The new job (201 Created).', schema: webhookJob, example: { ...webhookExample, id: 'c1d2e3f4-0000-4000-8000-000000000002', replayOfId: webhookExample.id } },
      errors: { 401: E401, 404: 'Unknown webhook job.' },
    }),
  },

  '/test-admin/chat/conversations': {
    get: op({
      tag: T_CHAT, summary: 'List all conversations', handler: 'ChatAdminController.list', security: SEC, errorShape: E,
      description: 'All conversations of all shops, oldest first (by seq), unpaginated. `identityKnown` is false for conversations created by POST /test-admin/chat/conversations (no matching buyer). `complaintTestLabel` is a test-data label, not a classifier output.',
      ok: {
        description: 'Conversations.',
        schema: obj({ items: arr(obj({ id: str('External id'), rowId: str('Internal row id'), shopId: str(), shopName: str(), buyerNickname: str(), buyerUserId: str(), buyerImUserId: str(), identityKnown: bool(), messages: int(), agentJoined: bool(), canSendMessage: bool(), dropSendResponse: bool(), complaintTestLabel: bool(), updatedAt: dt() })) }, ['items']),
        example: { items: [{ id: '5700000000000001', rowId: 'cv-uuid-1', shopId: SHOP_ID, shopName: 'Shop A', buyerNickname: 'nguyenvana', buyerUserId: '7000000000000001', buyerImUserId: '7000000000000002', identityKnown: true, messages: 4, agentJoined: false, canSendMessage: true, dropSendResponse: false, complaintTestLabel: false, updatedAt: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { 401: E401 },
    }),
    post: op({
      tag: T_CHAT, summary: 'Create a conversation from an unknown TikTok user', handler: 'ChatAdminController.createUnknown', security: SEC, errorShape: E, status: 201,
      description: 'Creates a conversation with a TikTok identity that matches no simulator buyer (identity-mismatch scenario) and posts the first BUYER text message, which emits the usual chat events.',
      body: { schema: obj({ shopId: str('Internal shop id', { minLength: 1 }), unknownBuyerNickname: str('Nickname of the unmatched user', { minLength: 1, maxLength: 100 }), text: str('First message', { minLength: 1, maxLength: 2000 }) }, ['shopId', 'unknownBuyerNickname', 'text']), example: { shopId: SHOP_ID, unknownBuyerNickname: 'stranger_42', text: 'Where is my order?' } },
      ok: { description: 'Created (201 Created).', schema: obj({ id: str('Conversation external id'), buyerUserId: str(), identityKnown: { type: 'boolean', enum: [false] }, messageId: str() }, ['id', 'buyerUserId', 'identityKnown', 'messageId']), example: { id: '5700000000000009', buyerUserId: '7000000000000099', identityKnown: false, messageId: '5800000000000123' } },
      errors: { 400: `${E400V} A whitespace-only text passes zod but may be refused by the chat service (\`invalid_text\`, ${ruleError400})`, 401: E401, 404: 'Unknown shop.' },
    }),
  },
  '/test-admin/chat/conversations/{ref}/buyer-message': {
    post: op({
      tag: T_CHAT, summary: 'Simulate a buyer message', handler: 'ChatAdminController.buyerMessage', security: SEC, errorShape: E, status: 201,
      description: 'Stores a BUYER text message and emits NEW_MESSAGE in the same transaction. `suppressEvent` stores the message but loses the event; `duplicateEvent` delivers the same event (same notification id) twice.',
      pathParams: [{ name: 'ref', description: 'Conversation row id or external id (404 if an external id matches several shops; then use the row id)', example: '5700000000000001' }],
      body: { schema: obj({ text: str(undefined, { minLength: 1, maxLength: 2000 }), suppressEvent: bool('Message stored but its NEW_MESSAGE event is lost'), duplicateEvent: bool('Same event delivered twice') }, ['text']), example: { text: 'Hello, is this in stock?', duplicateEvent: true } },
      ok: { description: 'Message stored (201 Created).', schema: obj({ messageId: str(), index: int('Per-conversation message index'), eventSuppressed: bool(), eventDuplicated: bool() }, ['messageId', 'index', 'eventSuppressed', 'eventDuplicated']), example: { messageId: '5800000000000124', index: 5, eventSuppressed: false, eventDuplicated: true } },
      errors: { 400: `${E400V} Whitespace-only text is refused with \`invalid_text\` (${ruleError400})`, 401: E401, 404: 'Unknown conversation, or `Conversation id is ambiguous; use the row id`.' },
    }),
  },
  '/test-admin/chat/conversations/{ref}/flags': {
    post: op({
      tag: T_CHAT, summary: 'Set conversation fault flags', handler: 'ChatAdminController.flags', security: SEC, errorShape: E, status: 201,
      description: '`dropSendResponse`: the seller send API stores the message but its response is dropped (indeterminate send). `canSendMessage`: whether sending is allowed. At least one of the two must be present.',
      pathParams: [{ name: 'ref', description: 'Conversation row id or external id', example: '5700000000000001' }],
      body: { schema: obj({ dropSendResponse: bool(), canSendMessage: bool() }, [], { minProperties: 1 }), example: { dropSendResponse: true } },
      ok: { description: 'Flags after the update (201 Created).', schema: obj({ id: str(), dropSendResponse: bool(), canSendMessage: bool() }, ['id', 'dropSendResponse', 'canSendMessage']), example: { id: '5700000000000001', dropSendResponse: true, canSendMessage: true } },
      errors: { 400: `${E400V} (\`nothing to update\` when the body has no keys).`, 401: E401, 404: 'Unknown conversation, or ambiguous external id.' },
    }),
  },
  '/test-admin/chat/conversations/{ref}/agent': {
    post: op({
      tag: T_CHAT, summary: 'Customer-service agent joins or leaves', handler: 'ChatAdminController.agent', security: SEC, errorShape: E, status: 201,
      description: 'Sets `agentJoined` and emits a NEW_CONVERSATION event (`AGENT_JOINED`, participant_count 3, or `AGENT_LEFT`, participant_count 2). The event payload is marked provisional in the code.',
      pathParams: [{ name: 'ref', description: 'Conversation row id or external id', example: '5700000000000001' }],
      body: { schema: obj({ joined: bool('true = agent joined, false = left') }, ['joined']), example: { joined: true } },
      ok: { description: 'Updated (201 Created).', schema: obj({ id: str(), agentJoined: bool() }, ['id', 'agentJoined']), example: { id: '5700000000000001', agentJoined: true } },
      errors: { 400: E400V, 401: E401, 404: 'Unknown conversation, or ambiguous external id.' },
    }),
  },

  '/test-admin/scenarios/loyalty-orders': {
    post: op({
      tag: T_SCEN, summary: 'Create loyalty-rule test orders', handler: 'LoyaltyAdminController.create', security: SEC, errorShape: E, status: 201,
      description: 'Creates five paid orders for one buyer (first buyer by external id unless `buyerId` is given) for the SmartOmni rule "points only after N days since completion" (N = `thresholdDays`; a SmartOmni rule, not a TikTok policy): completed N+1 days ago, exactly N days ago, N days minus 1 hour ago, DELIVERED only, and paid but still AWAITING_SHIPMENT. Each is checked out (1 unit of the first on-sale SKU with stock >= 10), paid and driven through the real state machine while the business clock is temporarily set (frozen) to the wanted time; the clock is restored afterwards (frozen stays frozen, a running clock keeps running). Not atomic: a failure midway leaves the orders already created.',
      body: { schema: obj({ shopId: str('Internal shop id', { minLength: 1 }), buyerId: str('Internal buyer id of that shop; default = first buyer', { minLength: 1 }), thresholdDays: int('N', { minimum: 1, maximum: 365, default: 15 }) }, ['shopId']), example: { shopId: SHOP_ID, thresholdDays: 15 } },
      ok: {
        description: 'Created orders (201 Created).',
        schema: obj({
          shopId: str(), thresholdDays: int(), note: str('Fixed text: points are computed from sub_total, never total_amount'),
          orders: arr(obj({ label: str(), orderId: str('Order external id'), status: str(), completedAt: nullable(dt()), deliveredAt: nullable(dt()), updatedAt: dt(), amountsVnd: obj({ productTotal: int(), sellerDiscount: int(), platformDiscount: int(), subTotal: int('productTotal - sellerDiscount - platformDiscount'), shippingFee: int('original shipping fee - shipping discount'), tax: int(), total: int('subTotal + shippingFee + tax') }) })),
        }, ['shopId', 'thresholdDays', 'note', 'orders']),
        example: { shopId: SHOP_ID, thresholdDays: 15, note: 'Loyalty points are computed by SmartOmni from the product amount actually paid (sub_total), never from total_amount which includes shipping/tax.', orders: [{ label: 'completed 16 days ago (eligible)', orderId: '5800000000000010', status: 'COMPLETED', completedAt: '2026-09-29T08:00:00.000Z', deliveredAt: '2026-09-29T08:00:00.000Z', updatedAt: '2026-09-29T08:00:00.000Z', amountsVnd: { productTotal: 45000, sellerDiscount: 0, platformDiscount: 0, subTotal: 45000, shippingFee: 15000, tax: 0, total: 60000 } }] },
      },
      errors: { 400: `${E400V} Also ${ruleError400} (checkout rules such as insufficient_stock).`, 401: E401, 404: 'Unknown shop; `No buyer for this shop`; or `No on-sale SKU with enough stock`.' },
    }),
  },
  '/test-admin/scenarios/loyalty-vouchers': {
    post: op({
      tag: T_SCEN, summary: 'Create loyalty voucher batches', handler: 'LoyaltyAdminController.createVouchers', security: SEC, errorShape: E, status: 201,
      description: 'Creates one batch of single-use PERCENT_OFF codes per tier (default Gold 10% / Platinum 20% / Diamond 30%; test data only, SmartOmni staff configure the real percentages), titled `Loyalty <name> <percentage>%`, valid from the current business time for `validDays`, `quantityPerTier` codes each (same rules as POST /demo/shops/{shopId}/coupon-batches). NOT idempotent: every call creates new batches with new codes. SmartOmni pulls the codes with Search Coupon List (`title_keyword`, case-insensitive).',
      body: {
        schema: obj({
          shopId: str('Internal shop id', { minLength: 1 }),
          quantityPerTier: int('Codes per tier', { minimum: 1, maximum: 500, default: 20 }),
          validDays: int('Validity from now (business clock)', { minimum: 1, maximum: 365, default: 30 }),
          tiers: arr(obj({ name: str('1-40 chars'), percentage: int(undefined, { minimum: 1, maximum: 100 }), maxDiscountVnd: int('Optional cap', { minimum: 1 }) }, ['name', 'percentage'])),
        }, ['shopId']),
        example: { shopId: SHOP_ID, quantityPerTier: 20, validDays: 30 },
      },
      ok: {
        description: 'Created batches (201 Created).',
        schema: obj({
          shopId: str(),
          batches: arr(obj({ tier: str(), batchId: str(), title: str(), percentage: int(), startAt: dt(), endAt: dt(), codes: arr(obj({ id: str('Coupon external id (coupon_id of the TikTok API)'), promoCode: str() })) })),
        }, ['shopId', 'batches']),
        example: { shopId: SHOP_ID, batches: [{ tier: 'Diamond', batchId: '0b6f1c2e-4d7a-4f0e-9a51-2c3d4e5f6a7b', title: 'Loyalty Diamond 30%', percentage: 30, startAt: '2026-11-20T00:00:00.000Z', endAt: '2026-12-20T00:00:00.000Z', codes: [{ id: '7700123456789013', promoCode: 'K7M2QX9PRT' }] }] },
      },
      errors: { 400: `${E400V} (e.g. percentage outside 1..100, quantityPerTier outside 1..500, unknown field).`, 401: E401, 404: 'Unknown shop.', 409: 'Could not generate unique codes after 3 attempts; retry.' },
    }),
  },
};
