import { expect, Page, request as pwRequest, test } from '@playwright/test';
import { BUYER_A, demoSession, resetAll, SELLER_A, shot, signInAs } from './helpers';

/**
 * Phase 09c UI: the seller creates a batch of single-use codes on the Seller Center; batch codes are private (not in the buyer's voucher
 * picker) but work when typed, once; an UNPAID cancel burns the code; the seller sees Used and the burned code as Deactivated.
 */
test.describe.configure({ mode: 'serial' });

let codes: string[] = [];

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

/** Buyer puts 2 x Trắng / M (129.000) in the cart and opens checkout from the cart. */
async function checkoutTwoWhiteTees(page: Page) {
  await signInAs(page, 'BUYER', BUYER_A, '/product/sim-product-a-tee');
  await page.getByRole('radio', { name: 'Trắng / M' }).click();
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();
  await page.goto('/cart');
  await expect(page.getByTestId('total')).toHaveText('₫258.000');
  await page.getByRole('button', { name: 'Check out (1)' }).click();
  await page.waitForURL('**/checkout');
}

async function expectVoucherError(page: Page) {
  const input = page.getByLabel('Voucher code');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const alert = page.locator(`[id="${await input.getAttribute('aria-describedby')}"]`);
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toBeVisible();
  await expect(page.getByText(/Order placed/)).toHaveCount(0);
  return alert;
}

test('the seller creates a batch of 3 codes and reads them in View codes', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/vouchers');
  await page.getByRole('tab', { name: 'Code batches' }).click();
  await page.getByRole('button', { name: 'New code batch' }).click();
  const dialog = page.getByRole('dialog', { name: 'New code batch' });
  await expect(dialog.getByText('Each code can be used once. Codes are private: buyers must type them.', { exact: false })).toBeVisible();
  await dialog.getByLabel('Title').fill('E2E Loyalty Diamond 30%');
  await dialog.getByLabel('Quantity (1-500)').fill('3');
  await dialog.getByLabel('Percent off (1-100)').fill('30');
  await dialog.getByRole('button', { name: 'Create batch' }).click();

  // the codes dialog opens on the new batch
  const view = page.getByRole('dialog', { name: 'Codes of E2E Loyalty Diamond 30%' });
  const rows = view.getByRole('row', { name: /^Code [A-HJ-NP-Z2-9]{10}$/ });
  await expect(rows).toHaveCount(3);
  codes = (await rows.allTextContents()).map((t) => t.slice(0, 10));
  expect(new Set(codes).size).toBe(3);
  await shot(page, 'phase09c-seller-codes');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: 'Batch E2E Loyalty Diamond 30%' }).getByText('0 / 3')).toBeVisible();
});

test('the voucher picker does not show batch codes; a typed code discounts the order once, then it is exhausted', async ({ page }) => {
  await checkoutTwoWhiteTees(page);
  await expect(page.getByRole('group', { name: 'Available vouchers' }).getByText(codes[0])).toHaveCount(0);
  await page.getByLabel('Voucher code').fill(codes[0].toLowerCase());
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('Order placed · UNPAID')).toBeVisible();
  // 2 x 129.000 = 258.000, 30% => 77.400 off => 180.600 items; + 25.000 shipping = 205.600
  await expect(page.getByText('-₫77.400')).toBeVisible();
  await expect(page.getByTestId('total')).toHaveText('₫205.600');
  await page.getByRole('button', { name: 'Pay now (simulated)' }).click();
  await page.waitForURL('**/account/orders');

  await checkoutTwoWhiteTees(page);
  await page.getByLabel('Voucher code').fill(codes[0]);
  await page.getByRole('button', { name: 'Place order' }).click();
  const alert = await expectVoucherError(page);
  await expect(alert).toContainText('no redemptions left');
  await shot(page, 'phase09c-buyer-exhausted');
});

test('cancelling an UNPAID order burns its code: typing it again is refused', async ({ page, baseURL }) => {
  // place an UNPAID order with the second code and cancel it over HTTP (same /demo calls as the UI)
  const api = await pwRequest.newContext({ baseURL });
  const buyer = await demoSession(api, 'BUYER', BUYER_A);
  const headers = { 'x-demo-session': buyer.token };
  const placed = await api.post(`/demo/shops/${buyer.shopId}/checkout`, {
    headers,
    data: { checkoutKey: `e2e-09c-${Date.now().toString(36)}`, items: [{ skuId: 'sim-sku-a-TEE-WHT-M', quantity: 1 }], couponCode: codes[1] },
  });
  expect(placed.status(), await placed.text()).toBe(201);
  const orderId = (await placed.json()).order.id as string;
  expect((await api.post(`/demo/shops/${buyer.shopId}/orders/${orderId}/cancel`, { headers, data: { reason: 'e2e' } })).ok()).toBe(true);
  await api.dispose();

  // the refused checkout of the previous test left the 2 tees in the cart
  await signInAs(page, 'BUYER', BUYER_A, '/cart');
  await expect(page.getByTestId('total')).toHaveText('₫258.000');
  await page.getByRole('button', { name: 'Check out (1)' }).click();
  await page.waitForURL('**/checkout');
  await page.getByLabel('Voucher code').fill(codes[1]);
  await page.getByRole('button', { name: 'Place order' }).click();
  const alert = await expectVoucherError(page);
  await expect(alert).toContainText('deactivated');
  await shot(page, 'phase09c-buyer-burned');
});

test('the seller sees Used 1 / 3 and the burned code as Deactivated', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/vouchers?tab=batches');
  const row = page.getByRole('row', { name: 'Batch E2E Loyalty Diamond 30%' });
  await expect(row.getByText('1 / 3')).toBeVisible();
  await expect(row.getByText('Ongoing')).toBeVisible();
  await row.getByRole('button', { name: 'View codes' }).click();
  const view = page.getByRole('dialog', { name: 'Codes of E2E Loyalty Diamond 30%' });
  await expect(view.getByRole('row', { name: `Code ${codes[0]}` }).getByText('Ongoing')).toBeVisible();
  await expect(view.getByRole('row', { name: `Code ${codes[1]}` }).getByText('Deactivated')).toBeVisible();
  await expect(view.getByRole('row', { name: `Code ${codes[2]}` }).getByText('Ongoing')).toBeVisible();
  await shot(page, 'phase09c-seller-used');
  // the single-voucher tab does not list batch codes
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Vouchers' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Voucher (${codes.join('|')})`) })).toHaveCount(0);
});
