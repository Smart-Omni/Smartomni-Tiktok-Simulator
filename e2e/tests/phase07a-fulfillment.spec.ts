import { expect, Page, request as pwRequest, test } from '@playwright/test';
import { BUYER_A, demoSession, placePaidOrder, resetAll, SELLER_A, shot, signInAs } from './helpers';

/** Phase 07a UI: an UNPAID order cannot be shipped; a paid order ships at once, the buyer follows tracking, the label PDF downloads. */
test.describe.configure({ mode: 'serial' });

let orderId = '';
const SKU = 'sim-sku-a-BAG-NAT';

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
  const api = await pwRequest.newContext({ baseURL });
  const buyer = await demoSession(api, 'BUYER', BUYER_A);
  orderId = await placePaidOrder(api, buyer, SKU, 1);
  await api.dispose();
});

const ORDERS = '/seller-center/orders';
const sellerRow = (page: Page) => page.getByRole('row', { name: `Order ${orderId}` });

test('an UNPAID order has nothing to ship and the API refuses to arrange shipment', async ({ page, request }) => {
  const buyer = await demoSession(request, 'BUYER', BUYER_A);
  const unpaid = await placePaidOrder(request, buyer, SKU, 1, false);
  await signInAs(page, 'SELLER', SELLER_A, ORDERS);
  const row = page.getByRole('row', { name: `Order ${unpaid}` });
  await expect(row.getByText('Unpaid', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Arrange shipment' })).toHaveCount(0);
  await expect(page.getByText(/On hold/)).toHaveCount(0);
  await shot(page, 'phase07a-unpaid');

  // even bypassing the UI, the backend refuses (400 order_unpaid) and creates nothing
  const seller = await demoSession(request, 'SELLER', SELLER_A);
  const res = await request.post(`/demo/shops/${seller.shopId}/orders/${unpaid}/arrange-shipment`, { headers: { 'x-demo-session': seller.token }, data: {} });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('order_unpaid');
});

test('right after payment the seller arranges shipment and the buyer sees tracking progress', async ({ page, request }) => {

  await signInAs(page, 'SELLER', SELLER_A, ORDERS);
  const row = sellerRow(page);
  await expect(row.getByText('To ship', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Arrange shipment' }).click();
  await expect(row.getByText('Awaiting collection', { exact: true })).toBeVisible();
  await expect(row.getByRole('cell').nth(3)).toHaveText(/SIM\d+/); // Package column: fake tracking number
  await row.getByRole('button', { name: 'Simulate carrier' }).click(); // carrier collects
  await expect(row.getByText('In transit', { exact: true })).toBeVisible();
  await shot(page, 'phase07a-seller-in-transit');

  await signInAs(page, 'BUYER', BUYER_A, '/account/orders');
  const card = page.getByRole('article', { name: `Order ${orderId}` });
  await expect(card.getByText('In transit', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Track' }).click();
  const panel = page.getByRole('region', { name: 'Tracking' });
  await expect(panel.getByText(/^SIM\d+$/)).toBeVisible();
  const timeline = panel.getByRole('list', { name: 'Tracking timeline' });
  await expect(timeline.getByRole('listitem').first()).toBeVisible();
  const before = await timeline.getByRole('listitem').count();

  // seller delivers (the seller session is still in this tab); the buyer timeline grows
  await page.goto(ORDERS);
  await sellerRow(page).getByRole('button', { name: 'Simulate carrier' }).click(); // delivered
  await expect(sellerRow(page).getByText('Delivered', { exact: true })).toBeVisible();
  await page.goto('/account/orders');
  await expect(card.getByText('Delivered', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Track' }).click();
  // the badge renders before the timeline is fetched: wait for the timeline instead of reading the count once
  await expect.poll(() => timeline.getByRole('listitem').count()).toBeGreaterThan(before);
  await shot(page, 'phase07a-buyer-delivered');
  await request.put('/test-admin/clock', { data: { reset: true } });
});

test('Print label serves a PDF stamped as test data', async ({ page, request }) => {
  await signInAs(page, 'SELLER', SELLER_A, ORDERS);
  // the button opens a tab and points it at the PDF url returned by shipping-label; read that url from the response
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/orders/${orderId}/shipping-label`)),
    sellerRow(page).getByRole('button', { name: 'Print label' }).click(),
  ]);
  const href = (await response.json()).url as string;
  expect(href).toMatch(/\.pdf$/);
  const pdf = await request.get(href);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('pdf');
  const body = await pdf.body();
  expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(body.length).toBeGreaterThan(300);
  expect(body.toString('latin1')).toContain('TEST DATA');
  await shot(page, 'phase07a-label');
});
