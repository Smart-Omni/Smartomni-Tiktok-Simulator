import { APIRequestContext, Page, request as pwRequest } from '@playwright/test';

const DEMO_PASSWORD = '123';

/** Wipes and re-seeds the simulator (through the UI proxy, which injects the admin token server-side). */
export async function resetAll(baseURL: string | undefined): Promise<void> {
  const api = await pwRequest.newContext({ baseURL });
  await api.post('/test-admin/seed');
  const prep = await (await api.post('/test-admin/reset/prepare', { data: { scope: 'ALL' } })).json();
  const res = await api.post('/test-admin/reset', { data: { scope: 'ALL', confirmationToken: prep.confirmationToken } });
  if (!res.ok()) throw new Error(`reset failed: ${res.status()}`);
  await api.post('/test-admin/seed');
  await api.dispose();
}

/**
 * Signs in on the TikTok Shop sign-in page (/login) and waits until the app has brought the user to `next`.
 * Every call creates a fresh demo session for that role in this tab (sessions live in sessionStorage, one per role).
 */
export async function signInAs(page: Page, role: 'BUYER' | 'SELLER', name: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}${role === 'SELLER' ? '&role=seller' : ''}`);
  await page.getByRole('tab', { name: role === 'BUYER' ? 'Buyer' : 'Seller' }).click();
  // the radio's accessible name is "<name> <shop · city>"; a string name matches as a substring
  await page.getByRole('radio', { name }).click();
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: `Sign in as ${name}` }).click();
  await page.waitForURL((url) => url.pathname + url.search === next);
}

export interface DemoSession {
  token: string;
  shopId: string;
  buyerId: string | null;
}

/** Demo session created over HTTP (setup shortcut; the flows under test are still driven through the UI). */
export async function demoSession(api: APIRequestContext, role: 'BUYER' | 'SELLER', name: string): Promise<DemoSession> {
  const ids = await (await api.get('/demo/identities')).json();
  const account = (role === 'BUYER' ? ids.buyers : ids.sellers).find((a: { name: string }) => a.name === name);
  const body = { role, email: account.email, password: DEMO_PASSWORD };
  const s = await (await api.post('/demo/sessions', { data: body })).json();
  return { token: s.sessionToken, shopId: s.shopId, buyerId: s.buyerId };
}

/** Buyer checkout + fake payment over HTTP. Returns the marketplace order id. */
export async function placePaidOrder(api: APIRequestContext, buyer: DemoSession, skuId: string, quantity = 1, pay = true): Promise<string> {
  const headers = { 'x-demo-session': buyer.token };
  const key = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const c = await api.post(`/demo/shops/${buyer.shopId}/checkout`, { headers, data: { checkoutKey: key, items: [{ skuId, quantity }] } });
  if (!c.ok()) throw new Error(`checkout failed ${c.status()}: ${await c.text()}`);
  const id = (await c.json()).order.id as string;
  if (pay) await api.post(`/demo/shops/${buyer.shopId}/orders/${id}/pay`, { headers, data: {} });
  return id;
}

export const SELLER_A = 'Nguyễn Thị Lan';
export const BUYER_A = 'Trần Văn An';
export const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true });
