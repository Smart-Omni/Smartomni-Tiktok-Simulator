import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession, StorefrontProduct } from '@/lib/types';
import { ProductPage } from '@/pages/shop/ProductPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };
// The product belongs to shop-2; the buyer's own shop (session.shopId) is shop-1.
const shop2 = { id: 'shop-2', name: 'Mộc Lan Shop' };
const tee: StorefrontProduct = {
  id: '7500T',
  title: 'Áo thun cotton basic',
  description: 'Cotton 100%',
  imageUrl: '/demo/media/products/t.svg',
  minPriceVnd: 129000,
  maxPriceVnd: 135000,
  skus: [
    { id: 'sku-wm', name: 'Trắng / M', attributeName: 'Màu / Size', priceVnd: 129000, available: true, stock: 2 },
    { id: 'sku-bm', name: 'Đen / M', attributeName: 'Màu / Size', priceVnd: 135000, available: true, stock: 9 },
  ],
};

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}
let lastState: unknown;
function StateProbe() {
  lastState = useLocation().state;
  return null;
}

/** `id` alone is an old link without a shop; pass `shop` for the real route. */
const renderProduct = (id: string, shop?: string) =>
  render(
    <MemoryRouter initialEntries={[shop ? `/product/${shop}/${id}` : `/product/${id}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/product/:shopId/:id" element={<ProductPage />} />
          <Route path="/product/:id" element={<ProductPage />} />
          <Route path="/checkout" element={<StateProbe />} />
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('ProductPage', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    lastState = undefined;
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === '/demo/catalog/shop-2/7500T') return json({ currency: 'VND', shop: shop2, product: tee });
        if (url === '/demo/catalog?limit=100') return json({ currency: 'VND', items: [{ ...tee, shop: shop2 }], nextCursor: null });
        if (url === '/demo/shops/shop-2/cart' && method === 'GET') {
          return json({ currency: 'VND', items: [{ skuId: 'sku-wm', quantity: 1 }], totalVnd: 129000 });
        }
        if (url === '/demo/shops/shop-2/cart/items') return json({ currency: 'VND', items: [], totalVnd: 0 });
        return json({ message: 'Not found' }, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('switches information tabs with keyboard and retains review filters', async () => {
    renderProduct('mock-1');
    const info = await screen.findByRole('tab', { name: 'Product information' });
    fireEvent.keyDown(info, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Ratings & reviews' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('group', { name: 'Filter reviews' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Ratings & reviews' }), { key: 'Home' });
    expect(screen.getByRole('tabpanel', { name: 'Product information' })).toBeTruthy();
  });
  it('changes the price with the selected SKU', async () => {
    renderProduct('mock-1');
    expect((await screen.findByTestId('price')).textContent).toBe('₫129.000');
    expect(screen.getByRole('radio', { name: 'White / M' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Black / M' }));
    expect(screen.getByTestId('price').textContent).toBe('₫135.000');
    expect(screen.getByText('12 available')).toBeTruthy();
  });

  it('disables sold-out variants in the selection grid', async () => {
    renderProduct('mock-1');
    const unavailable = await screen.findByRole('radio', { name: 'White / L' });
    expect(unavailable.hasAttribute('disabled')).toBe(true);
    fireEvent.click(unavailable);
    expect(unavailable.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: 'Black / M' }));
    expect(screen.getByRole('radio', { name: 'Black / M' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('price').textContent).toBe('₫135.000');
  });

  it('sends a guest who adds to cart to sign in and come back', async () => {
    renderProduct('mock-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Add to cart' }));
    expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fproduct%2Fmock-1');
    expect(calls).toEqual([]);
  });

  it('asks a guest to sign in for a real product id', async () => {
    renderProduct('7500T', 'shop-2');
    expect(await screen.findByText('Sign in to view this product.')).toBeTruthy();
  });

  it('adds to a buyer cart on top of what is already there, with the stepper capped by stock', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('7500T', 'shop-2');
    expect(await screen.findByRole('radio', { name: 'Trắng / M' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Chat with shop' })).toBeTruthy();
    const plus = screen.getByRole('button', { name: 'Increase quantity' }) as HTMLButtonElement;
    fireEvent.click(plus);
    expect((screen.getByRole('spinbutton', { name: 'Quantity' }) as HTMLInputElement).value).toBe('2');
    expect(plus.disabled).toBe(true); // stock is 2
    fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    // 1 already in the cart + 2 chosen, in the shop that sells the product (not the buyer's own shop)
    expect(calls.filter((c) => c.url.includes('/cart'))).toEqual([
      { url: '/demo/shops/shop-2/cart', method: 'GET', body: undefined },
      { url: '/demo/shops/shop-2/cart/items', method: 'PUT', body: { skuId: 'sku-wm', quantity: 3 } },
    ]);
  });

  it('Buy now adds the line and opens checkout with it preselected', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('7500T', 'shop-2');
    fireEvent.click(await screen.findByRole('radio', { name: 'Đen / M' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy now' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/checkout'));
    expect(lastState).toEqual({ items: [{ shopId: 'shop-2', skuId: 'sku-bm', quantity: 1 }] });
  });

  it('shows a not-available message when the product is not in the buyer shop', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('other', 'shop-2');
    expect(await screen.findByText('This product is not available.')).toBeTruthy();
  });

  it('opens a product of another shop and links to chat with that shop', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('7500T', 'shop-2');
    expect(await screen.findByRole('link', { name: 'Chat with shop' })).toHaveProperty('href', expect.stringContaining('/account/messages?shop=shop-2'));
  });

  it('sends an old link without a shop to the shop that sells the product', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('7500T');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/product/shop-2/7500T'));
    expect(await screen.findByRole('heading', { name: 'Áo thun cotton basic' })).toBeTruthy();
  });

  it('sends a signed-in buyer from a mock product to the seeded product with the same title', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('mock-1');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/product/shop-2/7500T'));
    expect(await screen.findByRole('heading', { name: 'Áo thun cotton basic' })).toBeTruthy();
  });

  it('says a mock product is not available when no seeded product matches', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderProduct('mock-2');
    expect(await screen.findByText('This item is not available.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to shopping' }).getAttribute('href')).toBe('/');
    expect(screen.getByTestId('location').textContent).toBe('/product/mock-2');
  });
});
