import { expect, request as pwRequest, test, APIRequestContext, Page } from '@playwright/test';
import { BUYER_A, demoSession, placePaidOrder, resetAll, SELLER_A, shot, signInAs } from './helpers';

/**
 * Phase 07b UI: partial return keeps the rest returnable and never turns the order into "RETURNED";
 * a unit cannot be requested twice; a buyer cancellation request on a paid AWAITING_SHIPMENT order needs seller approval.
 */
test.describe.configure({ mode: 'serial' });

const SKU = 'sim-sku-a-BAG-NAT';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8090';
let deliveredOrder = '';
let cancelOrder = '';

async function transition(api: APIRequestContext, orderId: string, to: string) {
  const r = await api.post(`/test-admin/orders/${orderId}/transition`, { data: { to } });
  expect(r.status(), `transition to ${to}: ${await r.text()}`).toBe(201);
}

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
  const api = await pwRequest.newContext({ baseURL });
  const buyer = await demoSession(api, 'BUYER', BUYER_A);
  deliveredOrder = await placePaidOrder(api, buyer, SKU, 2);
  cancelOrder = await placePaidOrder(api, buyer, SKU, 1);
  // paid orders are AWAITING_SHIPMENT at once (no hold); ship the first one to DELIVERED
  for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED']) await transition(api, deliveredOrder, to);
  await api.dispose();
});

test.afterAll(async ({ baseURL }) => {
  const api = await pwRequest.newContext({ baseURL });
  await api.put('/test-admin/clock', { data: { reset: true } });
  await api.dispose();
});

const card = (page: Page, orderId: string) => page.getByRole('article', { name: `Order ${orderId}` });
const requestRows = (page: Page, orderId: string) => page.getByRole('row', { name: /^Request / }).filter({ hasText: orderId });

/** Opens "Request return" on the order card, picks the (only) item and `units`, Refund only, first reason, and submits. */
async function requestReturn(page: Page, orderId: string, units: number) {
  await card(page, orderId).getByRole('button', { name: 'Request return' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request return' });
  await dialog.getByRole('checkbox', { name: /^Return / }).click();
  for (let i = 1; i < units; i++) await dialog.getByRole('button', { name: 'Increase quantity' }).click();
  await dialog.getByRole('radio', { name: 'Refund only' }).click();
  await dialog.getByRole('radiogroup', { name: 'Reason' }).getByRole('radio').first().click();
  await dialog.getByRole('button', { name: 'Submit request' }).click();
  return dialog;
}

test('buyer requests a partial return (1 of 2 units); seller approves; the order stays DELIVERED and the other unit is still returnable', async ({ page }) => {
  await signInAs(page, 'BUYER', BUYER_A, '/account/orders');
  // the units stepper stops at the 2 units bought
  await card(page, deliveredOrder).getByRole('button', { name: 'Request return' }).click();
  const probe = page.getByRole('dialog', { name: 'Request return' });
  await probe.getByRole('checkbox', { name: /^Return / }).click();
  await probe.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(probe.getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
  await probe.getByRole('button', { name: 'Cancel' }).click();

  const dialog = await requestReturn(page, deliveredOrder, 1);
  await expect(dialog).toHaveCount(0);
  // the new order card lists returns in its own "Return requests" section with a buyer-facing status label
  await expect(card(page, deliveredOrder).getByRole('region', { name: 'Return requests' })).toContainText('Awaiting seller review');
  await shot(page, 'phase07b-buyer-requested');

  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/returns?status=open');
  const sellerRow = requestRows(page, deliveredOrder);
  await expect(sellerRow.getByText('1× ')).toBeVisible();
  await sellerRow.getByRole('button', { name: 'Approve' }).click();
  await expect(sellerRow).toHaveCount(0); // decided: no longer open
  await page.goto('/seller-center/returns?status=all');
  const decided = requestRows(page, deliveredOrder);
  await expect(decided).toHaveCount(1);
  await expect(decided).not.toContainText(/pending/i);
  await expect(decided).not.toContainText(/returned/i);
  await shot(page, 'phase07b-seller-approved');

  // order status is unchanged: DELIVERED (the OAS has no RETURNED order status)
  await page.goto('/account/orders');
  await expect(card(page, deliveredOrder).getByText('Delivered', { exact: true })).toBeVisible();
  await expect(page.getByText(/returned/i)).toHaveCount(0);

  // the remaining unit is still offered: a 2nd request for 1 unit is accepted
  const second = await requestReturn(page, deliveredOrder, 1);
  await expect(second).toHaveCount(0);
  await page.goto('/seller-center/returns?status=all');
  await expect(requestRows(page, deliveredOrder)).toHaveCount(2);
  await shot(page, 'phase07b-second-unit');
});

test('a unit cannot be requested twice: a third request for the same order/item is refused with a visible message', async ({ page }) => {
  await signInAs(page, 'BUYER', BUYER_A, '/account/orders');
  const dialog = await requestReturn(page, deliveredOrder, 1);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('alert')).not.toBeEmpty();
  await shot(page, 'phase07b-refused');
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/returns?status=all');
  await expect(requestRows(page, deliveredOrder)).toHaveCount(2); // no third request was created
});

test('a buyer cancellation request on a paid AWAITING_SHIPMENT order is approved by the seller and the order becomes CANCELLED', async ({ page }) => {
  await signInAs(page, 'BUYER', BUYER_A, '/account/orders');
  await expect(card(page, cancelOrder).getByText('To ship', { exact: true })).toBeVisible();
  await card(page, cancelOrder).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Request cancellation' }).getByRole('button', { name: 'Send request' }).click();
  await expect(card(page, cancelOrder)).toContainText('Cancellation requested, waiting for the seller.');

  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/returns?status=open');
  const row = requestRows(page, cancelOrder);
  await expect(row).toContainText('Cancellation request pending');
  await shot(page, 'phase07b-cancel-pending');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toHaveCount(0);

  await page.goto('/account/orders');
  await expect(card(page, cancelOrder).getByText('Cancelled', { exact: true })).toBeVisible();
  await shot(page, 'phase07b-cancelled');
});

test('the RMA 202604 return paths are not served (unsupported, 404) and never replace Search Returns', async ({ page }) => {
  const api = await pwRequest.newContext({ baseURL: API_URL });
  for (const [method, path] of [['POST', '/return_refund/202604/returns/search'], ['PUT', '/return_refund/202604/returns'], ['POST', '/return_refund/202604/returns']] as const) {
    const r = method === 'POST' ? await api.post(path, { data: {} }) : await api.put(path, { data: {} });
    expect(r.status(), `${method} ${path}`).toBe(404);
  }
  await api.dispose();
  await page.goto('/');
});
