import { expect, test } from '@playwright/test';
import { resetAll, SELLER_A, shot, signInAs } from './helpers';

/**
 * Seller Center test tools (docs/seller-center-test-tools-plan.md): a tester prepares SmartOmni loyalty data without leaving
 * Seller Center: sandbox order, Force status to COMPLETED, loyalty tier batches and their code usage.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

test('creates a sandbox order and forces it to Completed from Manage orders', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/orders');
  await page.getByRole('button', { name: 'Test tools' }).click();
  const sheet = page.getByRole('dialog', { name: /Order test tools/ });
  await expect(sheet.getByText('TEST', { exact: true })).toBeVisible();
  await sheet.getByRole('checkbox').first().check();
  await sheet.getByRole('button', { name: 'Create test orders' }).click();
  await expect(sheet.getByRole('region', { name: 'Batch result' })).toBeVisible();
  const orderId = (await sheet.getByRole('region', { name: 'Batch result' }).getByText(/^\d{6,}$/).first().textContent())!.trim();
  await page.keyboard.press('Escape');

  const row = page.getByRole('row', { name: `Order ${orderId}` });
  await expect(row).toBeVisible();
  for (const status of ['Awaiting collection', 'In transit', 'Delivered', 'Completed']) {
    await row.getByRole('button', { name: `Force status of ${orderId}` }).click();
    await page.getByRole('menuitem', { name: status, exact: true }).click();
    await expect(row.getByRole('cell').nth(2)).toHaveText(status);
  }
  await expect(row.getByRole('button', { name: `Force status of ${orderId}` })).toHaveCount(0);
  await shot(page, 'seller-test-tools-orders');
});

test('creates loyalty orders and shows each case with its sub total', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/orders');
  await page.getByRole('button', { name: 'Test tools' }).click();
  const sheet = page.getByRole('dialog', { name: /Order test tools/ });
  await sheet.getByRole('tab', { name: 'Loyalty orders' }).click();
  await sheet.getByRole('button', { name: 'Generate loyalty orders' }).click();
  const table = sheet.getByRole('region', { name: 'Loyalty test orders' });
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByText('completed exactly 15 days ago (boundary)')).toBeVisible();
  await expect(table.getByText(/sub_total/)).toBeVisible();
});

test('generates loyalty tier batches and opens their code usage from Vouchers', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/vouchers?tab=batches');
  await page.getByRole('button', { name: 'Test tools' }).click();
  const sheet = page.getByRole('dialog', { name: /Voucher test tools/ });
  await sheet.getByRole('spinbutton', { name: 'Codes per tier' }).fill('3');
  await sheet.getByRole('button', { name: 'Generate voucher batches' }).click();
  await expect(sheet.getByText(/Created Loyalty Silver 10% \(3 codes\)/)).toBeVisible();
  await page.keyboard.press('Escape');

  const batch = page.getByRole('row', { name: 'Batch Loyalty Diamond 30%' });
  await expect(batch.getByText('0 / 3')).toBeVisible();
  await batch.getByRole('button', { name: 'View codes' }).click();
  await page.getByRole('dialog', { name: 'Codes of Loyalty Diamond 30%' }).getByRole('button', { name: 'View usage' }).click();
  const usage = page.getByRole('dialog', { name: /Code usage/ });
  await expect(usage.getByRole('row')).toHaveCount(4);
  await shot(page, 'seller-test-tools-vouchers');
});
