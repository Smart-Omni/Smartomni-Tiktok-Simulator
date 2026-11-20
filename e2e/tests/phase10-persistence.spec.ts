import { execSync } from 'child_process';
import { createHmac } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { APIRequestContext, expect, request as pwRequest, test } from '@playwright/test';
import { BUYER_A, demoSession, placePaidOrder, resetAll, SELLER_A } from './helpers';

/**
 * Phase 10 step 7: restart the API (and then DB + API) and prove data, job history, media and the business clock survive,
 * seeding is idempotent, and no raw token / app secret reaches the container logs or the stored HTTP log.
 * Needs the docker CLI and the compose project in the repo root (parent of e2e/).
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const ROOT = join(__dirname, '..', '..');
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8090';
const APP_KEY = 'smartomni-dev-app-key';
/** Same lookup as docker compose: SEED_APP_SECRET from the environment, else from the repo-root .env, else the compose default. */
function seedAppSecret(): string {
  if (process.env.SEED_APP_SECRET) return process.env.SEED_APP_SECRET;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => /^\s*SEED_APP_SECRET\s*=/.test(l));
    const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  return 'smartomni-dev-app-secret-fake'; // docker-compose.yml default
}
const APP_SECRET = seedAppSecret();
const SKU = 'sim-sku-a-BAG-NAT';

let dockerAvailable = true;
try {
  execSync('docker compose version', { cwd: ROOT, stdio: 'pipe' });
} catch {
  dockerAvailable = false;
}

interface Facts {
  orderId: string;
  sellerToken: string;
  shopId: string;
  buyerToken: string;
  conversationId: string;
  messageText: string;
  couponId: string;
  promoCode: string;
  pdfUrl: string;
  accessToken: string;
  refreshToken: string;
  clockOffsetMs: number;
  productCount: number;
  webhookJobId: string;
}
let f: Facts;

const ready = async () => {
  const api = await pwRequest.newContext();
  try {
    const r = await api.get(`${API_URL}/health/ready`, { timeout: 3000 });
    return r.ok();
  } catch {
    return false;
  } finally {
    await api.dispose();
  }
};
async function waitReady(maxMs = 180_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`API not ready after ${maxMs} ms`);
}
const compose = (args: string) => execSync(`docker compose ${args}`, { cwd: ROOT, stdio: 'pipe', timeout: 240_000 }).toString();

function signedGet(path: string, accessToken: string, api: APIRequestContext) {
  const q: Record<string, string> = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)) };
  const s = APP_SECRET + path + Object.keys(q).sort().map((k) => k + q[k]).join('') + APP_SECRET;
  q.sign = createHmac('sha256', APP_SECRET).update(s).digest('hex');
  return api.get(`${API_URL}${path}?${new URLSearchParams(q)}`, { headers: { 'x-tts-access-token': accessToken } });
}

test.beforeAll(async ({ baseURL }) => {
  test.skip(!dockerAvailable, 'docker CLI/compose is not available on this machine: restart persistence cannot be tested');
  await resetAll(baseURL);
  const api = await pwRequest.newContext({ baseURL });
  const buyer = await demoSession(api, 'BUYER', BUYER_A);
  const seller = await demoSession(api, 'SELLER', SELLER_A);
  const bh = { 'x-demo-session': buyer.token };
  const sh = { 'x-demo-session': seller.token };

  // an order (paid, then released and shipped far enough to have a package + label)
  const orderId = await placePaidOrder(api, buyer, SKU, 1);
  await api.put('/test-admin/clock', { data: { advanceMs: 31 * 60_000 } });
  await api.post('/test-admin/orders/release-due', { data: {} });
  expect((await api.post(`/demo/shops/${seller.shopId}/orders/${orderId}/arrange-shipment`, { headers: sh, data: {} })).ok()).toBe(true);
  const label = await (await api.post(`/demo/shops/${seller.shopId}/orders/${orderId}/shipping-label`, { headers: sh, data: {} })).json();

  // a chat message
  const messageText = `persist-${Date.now()}`;
  const sent = await (await api.post(`/demo/shops/${buyer.shopId}/chat/messages`, { headers: bh, data: { text: messageText } })).json();
  const convs = await (await api.get(`/demo/shops/${buyer.shopId}/chat/conversations`, { headers: bh })).json();

  // a coupon
  const promoCode = `PERSIST${Math.floor(Math.random() * 900 + 100)}`;
  const cr = await api.post(`/demo/shops/${seller.shopId}/coupons`, { headers: sh, data: { title: 'Persistence coupon', promoCode, discount: { type: 'AMOUNT_OFF', amountVnd: 10000 }, endAt: new Date(Date.now() + 40 * 24 * 3600_000).toISOString() } });
  expect(cr.status(), await cr.text()).toBeLessThan(300);
  const coupon = await cr.json();

  // a webhook job with history (nobody listens on port 9, so attempts fail and are recorded)
  const job = await (await api.post('/test-admin/webhooks', { data: { shopId: seller.shopId, topic: 'ORDER_STATUS_CHANGE', payload: { persist: true }, targetUrl: 'http://127.0.0.1:9/hook', maxAttempts: 2 } })).json();

  // real tokens through consent + token exchange (so the log checks have something to find)
  const consent = await (await api.post('/demo/authorization/consent', { headers: sh, data: { app_key: APP_KEY, decision: 'accept', state: 'persist' } })).json();
  const code = new URL(consent.redirectUrl).searchParams.get('code')!;
  const raw = pwRequest.newContext();
  const tok = await (await (await raw).get(`${API_URL}/api/v2/token/get?${new URLSearchParams({ app_key: APP_KEY, app_secret: APP_SECRET, auth_code: code, grant_type: 'authorized_code' })}`)).json();
  expect(tok.code).toBe(0);
  const accessToken = tok.data.access_token as string;
  const refreshToken = tok.data.refresh_token as string;
  expect((await signedGet('/authorization/202309/shops', accessToken, await raw)).status()).toBe(200);

  const clock = await (await api.get('/test-admin/clock')).json();
  const status = await (await api.get('/test-admin/status')).json();
  f = {
    orderId,
    sellerToken: seller.token,
    shopId: seller.shopId,
    buyerToken: buyer.token,
    conversationId: convs.items[0].id ?? sent.conversationId,
    messageText,
    couponId: coupon.id ?? coupon.externalId,
    promoCode,
    pdfUrl: label.url,
    accessToken,
    refreshToken,
    clockOffsetMs: clock.offsetMs,
    productCount: status.seed.products,
    webhookJobId: job.id,
  };
  expect(f.clockOffsetMs).toBeGreaterThan(30 * 60_000);
  await api.dispose();
});

test.afterAll(async ({ baseURL }) => {
  if (!dockerAvailable) return;
  const api = await pwRequest.newContext({ baseURL });
  await api.put('/test-admin/clock', { data: { reset: true } });
  await api.dispose();
});

/** Everything created in beforeAll must still be there (read through the normal APIs after a restart). */
async function assertSurvived(baseURL: string | undefined) {
  const api = await pwRequest.newContext({ baseURL });
  try {
    // the order and its history
    const detail = await (await api.get(`/demo/shops/${f.shopId}/orders/${f.orderId}`, { headers: { 'x-demo-session': f.sellerToken } })).json();
    expect(detail.order.status).toBe('AWAITING_COLLECTION');
    expect(detail.history.map((h: { to: string }) => h.to)).toEqual(expect.arrayContaining(['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'AWAITING_COLLECTION']));
    // webhook job + attempts
    const hooks = await (await api.get(`/test-admin/webhooks?shopId=${f.shopId}`)).json();
    const job = hooks.items.find((j: { id: string }) => j.id === f.webhookJobId);
    expect(job, 'webhook job survived').toBeTruthy();
    expect(job.attempts.length).toBeGreaterThanOrEqual(1);
    // chat message
    const msgs = await (await api.get(`/demo/shops/${f.shopId}/chat/conversations/${f.conversationId}/messages`, { headers: { 'x-demo-session': f.sellerToken } })).json();
    expect(JSON.stringify(msgs.items)).toContain(f.messageText);
    // coupon
    const coupons = await (await api.get(`/demo/shops/${f.shopId}/coupons`, { headers: { 'x-demo-session': f.sellerToken } })).json();
    expect(JSON.stringify(coupons)).toContain(f.promoCode);
    // shipping PDF: same URL, still a PDF
    const pdf = await api.get(f.pdfUrl);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // business clock offset preserved (it is stored in the database, not in process memory)
    const clock = await (await api.get('/test-admin/clock')).json();
    expect(clock.offsetMs).toBe(f.clockOffsetMs);
    expect(clock.frozen).toBe(false);
    // the token issued before the restart still authenticates (only hashes are stored)
    const raw = await pwRequest.newContext();
    expect((await signedGet('/authorization/202309/shops', f.accessToken, raw)).status()).toBe(200);
    await raw.dispose();
  } finally {
    await api.dispose();
  }
}

test('data, job history, media and the business clock survive an API restart', async ({ baseURL }) => {
  test.skip(!dockerAvailable, 'docker CLI/compose is not available on this machine');
  compose('restart api');
  await waitReady();
  await assertSurvived(baseURL);
});

test('data survives a restart of the database and the API together', async ({ baseURL }) => {
  test.skip(!dockerAvailable, 'docker CLI/compose is not available on this machine');
  compose('restart db api');
  await waitReady();
  await assertSurvived(baseURL);
});

test('re-running the seed is idempotent and does not touch business data', async ({ baseURL }) => {
  test.skip(!dockerAvailable, 'docker CLI/compose is not available on this machine');
  const api = await pwRequest.newContext({ baseURL });
  const before = await (await api.get('/test-admin/status')).json();
  expect((await api.post('/test-admin/seed')).ok()).toBe(true);
  expect((await api.post('/test-admin/seed')).ok()).toBe(true);
  const after = await (await api.get('/test-admin/status')).json();
  expect(after.seed.products).toBe(f.productCount);
  expect(after.seed).toEqual(before.seed);
  await assertSurvived(baseURL);
  await api.dispose();
});

test('no raw access token, refresh token or app secret appears in the API container logs or in the stored HTTP log', async ({ baseURL }) => {
  test.skip(!dockerAvailable, 'docker CLI/compose is not available on this machine');
  const logs = compose('logs api');
  expect(logs.length).toBeGreaterThan(100);
  for (const secret of [f.accessToken, f.refreshToken, APP_SECRET]) expect(logs, 'container logs must not contain a secret').not.toContain(secret);
  const api = await pwRequest.newContext({ baseURL });
  const http = await (await api.get('/test-admin/http-logs?limit=200')).text();
  for (const secret of [f.accessToken, f.refreshToken, APP_SECRET]) expect(http, 'stored HTTP log must not contain a secret').not.toContain(secret);
  await api.dispose();
});
