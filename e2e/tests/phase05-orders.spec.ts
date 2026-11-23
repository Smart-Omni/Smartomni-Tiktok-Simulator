import { expect, request as pwRequest, test } from '@playwright/test';
import { BUYER_A, demoSession, placePaidOrder, SELLER_A, signInAs } from './helpers';

/**
 * Phase 05 UI flow: marketplace product link -> Buyer sign-in -> pick SKU -> cart -> checkout -> fake payment ->
 * Seller sees the order ready to ship (no hold period) -> Test Console refuses to ship an unpaid order.
 * Requires a seeded stack; resets the demo data at the start so the run is repeatable.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  const api = await pwRequest.newContext({ baseURL });
  await api.post('/test-admin/seed');
  // clear previous orders of earlier runs so counts are deterministic
  const prep = await (await api.post('/test-admin/reset/prepare', { data: { scope: 'ALL' } })).json();
  await api.post('/test-admin/reset', { data: { scope: 'ALL', confirmationToken: prep.confirmationToken } });
  await api.post('/test-admin/seed');
  await api.dispose();
});

let orderId = '';
const TEE = '/product/sim-product-a-tee';

test('a marketplace product link opens the right product for a buyer and the SKU picker selects the variant', async ({ page }) => {
  // the old /buyer link still works and lands on the product page, which asks a guest to sign in
  await page.goto('/buyer/product/sim-product-a-tee');
  await expect(page).toHaveURL(new RegExp(`${TEE}$`));
  await expect(page.getByText('Sign in to view this product.')).toBeVisible();
  await signInAs(page, 'BUYER', BUYER_A, TEE);
  // the selling shop is shown in the breadcrumb (Home > shop > product)
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Cửa hàng Mộc Lan');
  await expect(page.getByRole('heading', { level: 1, name: 'Áo thun cotton basic' })).toBeVisible();
  await page.getByRole('radio', { name: 'Đen / M' }).click();
  await expect(page.getByTestId('price')).toHaveText('₫135.000');
  await expect(page.getByRole('radio', { name: 'Đen / M' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Trắng / M' })).toHaveAttribute('aria-checked', 'false');
});

test('buyer adds two units to the cart, checks out and pays with the fake payment', async ({ page }) => {
  await signInAs(page, 'BUYER', BUYER_A, TEE);
  await page.getByRole('radio', { name: 'Trắng / M' }).click();
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();
  await page.getByRole('link', { name: 'Cart', exact: true }).click();
  await expect(page.getByTestId('total')).toHaveText('₫258.000');
  await page.getByRole('button', { name: 'Check out (1)' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();
  const placed = page.locator('[role="status"]', { hasText: 'Order placed' });
  await expect(placed).toContainText('Order placed · UNPAID');
  await expect(page.getByTestId('total')).toHaveText('₫283.000'); // 258.000 items + 25.000 shipping
  orderId = (await placed.locator('.font-mono').innerText()).trim();
  await page.getByRole('button', { name: 'Pay now (simulated)' }).click();
  await page.waitForURL('**/account/orders');
  await expect(page.getByRole('article', { name: `Order ${orderId}` }).getByText('To ship', { exact: true })).toBeVisible(); // paid orders are AWAITING_SHIPMENT at once
});

test('seller can ship the paid order at once; the Test Console refuses to ship an UNPAID order', async ({ page, request }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/orders');
  const sellerRow = page.getByRole('row', { name: `Order ${orderId}` });
  await expect(sellerRow.getByText('To ship', { exact: true })).toBeVisible();
  await expect(sellerRow.getByRole('button', { name: 'Arrange shipment' })).toBeVisible();
  await page.goto(`/seller-center/orders/${orderId}`);
  await expect(page.getByRole('region', { name: 'Status history' })).toContainText('Unpaid → Awaiting shipment');

  // an unpaid order: shipping it is an invalid jump the API refuses, and nothing changes
  const buyer = await demoSession(request, 'BUYER', BUYER_A);
  const unpaid = await placePaidOrder(request, buyer, 'sim-sku-a-BAG-NAT', 1, false);
  await page.goto('/console');
  await page.getByRole('navigation', { name: 'Test Console navigation' }).getByRole('button', { name: 'Orders', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(unpaid) });
  await row.getByRole('button', { name: 'Awaiting collection' }).click(); // readable label; the API value is AWAITING_COLLECTION
  await expect(page.getByRole('status').filter({ hasText: 'UNPAID -> AWAITING_COLLECTION is not allowed' })).toBeVisible(); // the console has more than one status region
  await expect(row.getByText('Unpaid', { exact: true })).toBeVisible(); // unchanged
  await expect(page.getByRole('button', { name: 'Release due holds' })).toHaveCount(0);
});
