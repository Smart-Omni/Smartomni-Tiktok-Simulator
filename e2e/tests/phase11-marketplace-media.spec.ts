import { expect, test } from '@playwright/test';
import { BUYER_A, resetAll, SELLER_A, shot, signInAs } from './helpers';

/**
 * docs/product-media-plan.md: the seller creates a product with an uploaded image and a category on the product page,
 * and a buyer buys it together with a product of another shop (one order per shop).
 */
test.describe.configure({ mode: 'serial' });

/** A real 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TITLE = `E2E linen cushion ${Date.now().toString(36)}`;

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

test('seller creates a product with an uploaded image and a category on the product page', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/products');
  await page.getByRole('link', { name: 'New product' }).click();
  await page.waitForURL('**/seller-center/products/new');

  await page.getByLabel('Title *').fill(TITLE);
  await page.getByTestId('image-input').setInputFiles({ name: 'cushion.png', mimeType: 'image/png', buffer: PNG });
  const main = page.getByRole('listitem', { name: 'Image 1 (main)' }).locator('img');
  await expect(main).toHaveAttribute('src', /\/demo\/media\/images\/[0-9a-f-]{36}$/);

  await page.getByLabel('Search categories').fill('Nhà cửa');
  await page.getByRole('list', { name: 'Matching categories' }).getByRole('button', { name: 'Nhà cửa & Đời sống' }).click();
  await expect(page.getByText('Selected: Nhà cửa & Đời sống')).toBeVisible();
  await page.getByLabel('Weight (kg)').fill('0.6');
  await page.getByLabel('Seller SKU 1').fill('E2E-CUSH-1');
  await page.getByLabel('Variant name 1').fill('Beige');
  await page.getByLabel('Price 1').fill('99000');
  await shot(page, 'phase11-product-form');
  await page.getByRole('button', { name: 'Create product' }).click();

  await page.waitForURL('**/seller-center/products');
  const card = page.getByRole('region', { name: /^Product / }).filter({ hasText: TITLE });
  await expect(card.getByRole('img', { name: `Main image of ${TITLE}` })).toBeVisible();
  await expect(card.getByText('Nhà cửa & Đời sống')).toBeVisible();

  // give the new variant stock so a buyer can order it
  await card.getByRole('textbox', { name: /^Stock of E2E-CUSH-1 in / }).first().fill('20');
  await card.getByRole('row', { name: 'SKU E2E-CUSH-1' }).getByRole('button', { name: 'Set' }).last().click();
  await expect(page.getByText('Stock updated')).toBeVisible();
});

test('a buyer sees the image and buys from two shops in one checkout: one order per shop', async ({ page, request }) => {
  await signInAs(page, 'BUYER', BUYER_A, '/');
  await page.getByRole('link', { name: new RegExp(TITLE) }).first().click();
  await page.waitForURL(/\/product\/[^/]+\/[^/]+$/);
  await expect(page.locator('img[src*="/demo/media/images/"]').first()).toBeVisible();
  const beige = page.getByRole('radio', { name: 'Beige' });
  if (await beige.count()) await beige.click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();

  // a product of another shop (Bát Tràng), opened by its marketplace link
  const catalog = await (await request.get('/demo/catalog?limit=100')).json();
  const other = catalog.items.find((p: { shop: { name: string }; skus: { available: boolean }[] }) => p.shop.name.includes('Bát Tràng') && p.skus.some((s) => s.available));
  expect(other).toBeTruthy();
  await page.goto(`/product/${other.shop.id}/${other.id}`);
  const sku = other.skus.find((s: { available: boolean }) => s.available);
  const radio = page.getByRole('radio', { name: sku.name });
  if (await radio.count()) await radio.click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to cart')).toBeVisible();

  await page.goto('/cart');
  await expect(page.getByRole('region', { name: other.shop.name })).toBeVisible();
  await expect(page.getByRole('region', { name: /Mộc Lan/ })).toBeVisible();
  await page.getByRole('button', { name: /^Check out \(2\)$/ }).click();
  await page.waitForURL('**/checkout');
  await shot(page, 'phase11-checkout-two-shops');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('2 orders placed')).toBeVisible();
  await page.getByRole('button', { name: 'Pay now (simulated)' }).click();
  await page.waitForURL('**/account/orders');
  await expect(page.getByText(TITLE)).toBeVisible();
  await expect(page.getByText(other.title).first()).toBeVisible();
});
