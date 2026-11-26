import { expect, test } from '@playwright/test';
import { BUYER_A, resetAll, SELLER_A, shot, signInAs } from './helpers';

/** Phase 06 UI: Seller stock edit -> before/after history; Buyer sees sold out at 0; Test Console shows the inventory panel and fault kinds. */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

test('seller sets a SKU stock to 0 and the Inventory tab shows before/after', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/products');
  // product cards are collapsed; "Manage" opens the variants & inventory table
  const product = page.getByRole('region', { name: /^Product / }).filter({ hasText: 'BAG-NVY' });
  await product.getByRole('button', { name: 'Manage' }).click();
  const row = product.getByRole('row', { name: 'SKU BAG-NVY' });
  await expect(row).toBeVisible();
  const input = row.getByLabel('Stock of BAG-NVY in Kho Hà Nội');
  await expect(input).toHaveValue('30');
  await input.fill('0');
  await row.getByRole('button', { name: 'Set' }).nth(1).click(); // the second "Set" in the row is the stock one
  await expect(row.getByLabel('Stock of BAG-NVY in Kho Hà Nội')).toHaveValue('0');

  await page.getByRole('button', { name: 'Stock history' }).click();
  await expect(page.getByRole('heading', { name: 'Stock changes (before / after)' })).toBeVisible();
  const hn = page.getByRole('row').filter({ hasText: 'BAG-NVY' }).filter({ hasText: 'Kho Hà Nội' });
  await expect(hn.getByRole('cell').nth(3)).toHaveText('30'); // before
  await expect(hn.getByRole('cell').nth(4)).toHaveText('0'); // after
  await expect(hn.getByText('SELLER', { exact: true })).toBeVisible();
  await shot(page, 'phase06-inventory-history');
});

test('the buyer sees the sold-out SKU disabled while another variant stays selectable', async ({ page }) => {
  await signInAs(page, 'BUYER', BUYER_A, '/product/sim-product-a-bag');
  const sold = page.getByRole('radio', { name: 'Xanh navy', exact: true });
  await expect(sold).toBeDisabled();
  const ok = page.getByRole('radio', { name: 'Màu tự nhiên', exact: true });
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(ok).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'phase06-buyer-sold-out');
});

test('the Test Console shows the Inventory panel and the inventory fault kinds', async ({ page }) => {
  await page.goto('/console');
  // the console sidebar uses navigation buttons; the inventory fault kinds are offered on the Fault injection screen
  const nav = page.getByRole('navigation', { name: 'Test Console navigation' });
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Stock changes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Update requests' })).toBeVisible();
  await nav.getByRole('button', { name: 'Fault injection' }).click();
  await page.getByRole('button', { name: 'New fault' }).click(); // the form opens on demand
  const kind = page.getByLabel('Kind');
  for (const k of ['TIMEOUT_BEFORE_WRITE', 'TIMEOUT_AFTER_WRITE', 'APP_ERROR_200']) await expect(kind.locator(`option[value="${k}"], option:text-is("${k}")`).first()).toBeAttached();
  await shot(page, 'phase06-console-faults');
});
