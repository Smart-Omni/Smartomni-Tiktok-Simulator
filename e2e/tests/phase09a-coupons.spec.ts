import { expect, Page, test } from '@playwright/test';
import { BUYER_A, resetAll, SELLER_A, shot, signInAs } from './helpers';

/** Phase 09a UI: Seller creates coupons (demo data), Buyer applies a code at checkout; bad codes show clear errors; no voucher-creation route is exposed. */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

async function createCoupon(page: Page, title: string, code: string, valueVnd: string, minSpend = '') {
  await page.getByRole('button', { name: 'New voucher' }).click();
  const dialog = page.getByRole('dialog', { name: 'New voucher' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Code').fill(code);
  await dialog.getByLabel('Amount off (VND)').fill(valueVnd);
  if (minSpend) await dialog.getByLabel('Minimum spend VND (optional)').fill(minSpend);
  await dialog.getByRole('button', { name: 'Create voucher' }).click();
  await expect(page.getByRole('row', { name: `Voucher ${code}` })).toBeVisible();
}

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

test('seller creates coupons; the buyer applies one at checkout and the order total reflects the discount', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/vouchers');
  await createCoupon(page, 'E2E 50k off', 'E2EOFF50', '50000');
  await createCoupon(page, 'E2E big spender', 'E2EMIN1M', '10000', '1000000');
  await createCoupon(page, 'E2E to deactivate', 'E2EOLD99', '5000');
  await expect(page.getByRole('row', { name: 'Voucher E2EOFF50' }).getByText('Ongoing')).toBeVisible();
  await page.getByRole('row', { name: 'Voucher E2EOLD99' }).getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('row', { name: 'Voucher E2EOLD99' }).getByText('Deactivated')).toBeVisible();
  await shot(page, 'phase09a-seller-coupons');

  await checkoutTwoWhiteTees(page);
  await page.getByLabel('Voucher code').fill('e2eoff50'); // the input upper-cases
  await expect(page.getByLabel('Voucher code')).toHaveValue('E2EOFF50');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('Order placed · UNPAID')).toBeVisible();
  // 2 x 129.000 = 258.000 - 50.000 coupon = 208.000 items; + 25.000 shipping = 233.000
  await expect(page.getByTestId('total')).toHaveText('₫233.000');
  await expect(page.getByText('-₫50.000')).toBeVisible();
  await shot(page, 'phase09a-buyer-discounted');
  await page.getByRole('button', { name: 'Pay now (simulated)' }).click();
  await page.waitForURL('**/account/orders');
});

test('unknown, deactivated and under-minimum coupons are refused with a visible error and no order is created', async ({ page }) => {
  await checkoutTwoWhiteTees(page);
  for (const code of ['NOPE1234', 'E2EOLD99', 'E2EMIN1M']) {
    await page.getByLabel('Voucher code').fill(code);
    await page.getByRole('button', { name: 'Place order' }).click();
    // the error is shown right under the voucher field of the shop (the field points at it with aria-describedby)
    const input = page.getByLabel('Voucher code');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = page.locator(`[id="${await input.getAttribute('aria-describedby')}"]`);
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toBeEmpty();
    await expect(page.getByText(/Order placed/)).toHaveCount(0);
    await shot(page, `phase09a-error-${code}`);
  }
  // no order was created, so the cart is untouched
  await page.goto('/cart');
  await expect(page.getByTestId('total')).toHaveText('₫258.000');
});

test('no voucher-creation operation is exposed: the router answers 404 and the UI says coupons are demo data', async ({ page, request }) => {
  for (const [method, path] of [['POST', '/promotion/202406/coupons'], ['POST', '/promotion/202406/coupons/create'], ['PUT', '/promotion/202406/coupons/1']] as const) {
    // the TikTok router lives on the API port (the UI proxy only forwards /demo, /test-admin, /health)
    const res = await request.fetch(`${process.env.E2E_API_URL ?? 'http://localhost:8090'}${path}`, { method, data: { title: 'x' } });
    expect(res.status(), `${method} ${path}`).toBe(404);
  }
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/vouchers');
  await expect(page.getByText('Vouchers are seller-created demo data.')).toBeVisible();
  await expect(page.locator('main').getByText(/TikTok|OpenAPI/i)).toHaveCount(0);
});
