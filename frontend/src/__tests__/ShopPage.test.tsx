import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { ShopPage } from '@/pages/shop/ShopPage';
import { listMarketplaceProducts } from '@/lib/endpoints';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const product = (i: number, shopId = 'shop-1') => ({ id: `product-${i}`, title: i === 19 ? 'Áo khoác đẹp' : `Item ${i}`, description: '', minPriceVnd: i * 10000, maxPriceVnd: i * 10000, imageUrl: `/image-${i}.jpg`, skus: [], shop: { id: shopId, name: shopId === 'shop-1' ? 'First shop' : 'Second shop' } });
function show() {
  return render(<MemoryRouter initialEntries={['/shop/shop-1']}><AuthProvider><Link to="/shop/shop-2">Other shop</Link><Routes><Route path="/shop/:shopId" element={<ShopPage />} /></Routes></AuthProvider></MemoryRouter>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('loads the selected shop, paginates, searches without diacritics and sorts real prices', async () => {
  const fetcher = vi.fn(async () => json({ items: [...Array.from({ length: 19 }, (_, i) => product(i + 1)), product(99, 'shop-2')], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  show();
  await screen.findByRole('heading', { name: 'First shop' });
  expect(fetcher).toHaveBeenCalledWith('/demo/catalog?limit=100&shopId=shop-1', expect.anything());
  const catalog = screen.getByRole('region', { name: 'Shop products' });
  expect(within(catalog).getAllByRole('link')).toHaveLength(18);
  expect(screen.queryByText('Item 99')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByRole('link', { name: /Áo khoác đẹp/ }).getAttribute('href')).toBe('/product/shop-1/product-19');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search in this shop' }), { target: { value: 'ao khoac' } });
  expect(screen.getByText('1–1 of 1')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search in this shop' }), { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort shop products' }), { target: { value: 'price-desc' } });
  expect(within(catalog).getAllByRole('link')[0].textContent).toContain('Áo khoác đẹp');
  expect(screen.queryByText(/sold/)).toBeNull();
});

it('resets filters and old products when navigating to a different shop', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json({ items: [product(url.includes('shop-2') ? 2 : 1, url.includes('shop-2') ? 'shop-2' : 'shop-1')], nextCursor: null })));
  show();
  await screen.findByText('Item 1');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search in this shop' }), { target: { value: 'Item 1' } });
  fireEvent.click(screen.getByRole('link', { name: 'Other shop' }));
  expect(screen.queryByText('Item 1')).toBeNull();
  expect(await screen.findByText('Item 2')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Search in this shop' }) as HTMLInputElement).value).toBe('');
});

it('shows API failures and empty shops without falling back to mock products', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ message: 'Catalog unavailable' }, 503)).mockResolvedValueOnce(json({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  show();
  expect((await screen.findByRole('alert')).textContent).toContain('Catalog unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No products available in this shop.')).toBeTruthy();
});

it('keeps the shop filter on every cursor request and encodes URL values', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ items: [product(1)], nextCursor: 'next/1' })).mockResolvedValueOnce(json({ items: [product(2)], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  expect(await listMarketplaceProducts('shop/1')).toHaveLength(2);
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual(['/demo/catalog?limit=100&shopId=shop%2F1', '/demo/catalog?limit=100&shopId=shop%2F1&cursor=next%2F1']);
});
