import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { Identities } from '@/lib/types';
import { destination, LoginPage, preferredBuyerId, safeNext } from '@/pages/LoginPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const identities: Identities = {
  sellers: [
    { id: 'seller_1', name: 'Seller One', shops: [{ id: 'shop-1', name: 'Demo Shop VN' }] },
    { id: 'seller_2', name: 'Seller Two', shops: [{ id: 'shop-2', name: 'Pottery Shop' }] },
  ],
  buyers: [{ id: 'buyer_1', name: 'Trần Văn An', shopId: 'shop-1' }],
};

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

const renderLogin = (path = '/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('LoginPage', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let ids: Identities = identities;
  beforeEach(() => {
    calls.length = 0;
    ids = identities;
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method: init?.method ?? 'GET', body });
        if (url === '/demo/identities') return json(ids);
        if (url === '/demo/sessions') {
          const role = body.role as 'BUYER' | 'SELLER';
          return json({ sessionToken: 't', role, shopId: 'shop-1', buyerId: role === 'BUYER' ? body.buyerId : null, expiresAt: future }, 201);
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists buyers with shop and city, and names the sign-in button after the selected account', async () => {
    renderLogin();
    expect(await screen.findByRole('button', { name: 'Sign in as Trần Văn An' })).toBeTruthy();
    expect(screen.getByText('Ho Chi Minh City')).toBeTruthy();
    expect(screen.queryByText(/Demo Shop VN/)).toBeNull();
  });

  it('renames the button when switching to the Seller tab and picking another seller', async () => {
    renderLogin();
    await screen.findByRole('button', { name: 'Sign in as Trần Văn An' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Seller' }));
    expect(await screen.findByRole('button', { name: 'Sign in as Seller One' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Seller Two/ }));
    expect(screen.getByRole('button', { name: 'Sign in as Seller Two' })).toBeTruthy();
  });

  it('signs a seller in through POST /demo/sessions and opens Seller Center', async () => {
    renderLogin('/login?role=seller');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in as Seller One' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/seller-center'));
    expect(calls).toContainEqual({ url: '/demo/sessions', method: 'POST', body: { role: 'SELLER', sellerId: 'seller_1' } });
    expect(sessionStorage.getItem('sim.demo-session.SELLER')).not.toBeNull();
  });

  it('returns a buyer to ?next after signing in, with a banner naming where they go back to', async () => {
    renderLogin('/login?next=%2Fcart');
    expect(screen.getByText(/You will return to/).textContent).toBe('Sign in to continue. You will return to your cart after signing in.');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in as Trần Văn An' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/cart'));
    expect(calls).toContainEqual({ url: '/demo/sessions', method: 'POST', body: { role: 'BUYER', buyerId: 'buyer_1' } });
  });

  it('points to the Test Console when there are no accounts', async () => {
    ids = { sellers: [], buyers: [] };
    renderLogin();
    const link = await screen.findByRole('link', { name: 'Open Test Console and run Seed' });
    expect(link.getAttribute('href')).toBe('/console');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Same shape as the seed: two shops, buyers listed out of order. */
const seedIds: Identities = {
  sellers: [
    { id: 'seller_a', name: 'Nguyễn Thị Lan', shops: [{ id: 'shop-a', name: 'Cửa hàng Mộc Lan' }] },
    { id: 'seller_b', name: 'Đặng Minh Quân', shops: [{ id: 'shop-b', name: 'Tiệm Gốm Bát Tràng' }] },
  ],
  buyers: [
    { id: 'buyer_long', name: 'Hoàng Đức Long', shopId: 'shop-b' },
    { id: 'buyer_ha', name: 'Lê Thu Hà', shopId: 'shop-a' },
    { id: 'buyer_an', name: 'Trần Văn An', shopId: 'shop-a' },
  ],
};

describe('preselected buyer', () => {
  it('is Trần Văn An without a product in next', () => {
    expect(preferredBuyerId(seedIds, null)).toBe('buyer_an');
    expect(preferredBuyerId(seedIds, '/cart')).toBe('buyer_an');
    expect(preferredBuyerId(seedIds, '/product/7500000000000001')).toBe('buyer_an');
  });

  it('is a buyer of the shop selling the mock product in next', () => {
    expect(preferredBuyerId(seedIds, '/product/mock-1')).toBe('buyer_ha');
    expect(preferredBuyerId(seedIds, '/product/mock-4')).toBe('buyer_long');
    // no seedShop: the default mock shop (Mộc Lan)
    expect(preferredBuyerId(seedIds, '/product/mock-10')).toBe('buyer_ha');
  });

  it('is checked on the sign-in page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(seedIds)));
    renderLogin('/login?next=%2Fproduct%2Fmock-4');
    expect(await screen.findByRole('button', { name: 'Sign in as Hoàng Đức Long' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Hoàng Đức Long/ }).getAttribute('aria-checked')).toBe('true');
    cleanup();
    renderLogin('/login');
    expect(await screen.findByRole('button', { name: 'Sign in as Trần Văn An' })).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
  });
});

describe('sign-in redirects', () => {
  it('only accepts same-origin paths as next', () => {
    expect(safeNext('/cart')).toBe('/cart');
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('/\\evil.example')).toBeNull();
    expect(safeNext(null)).toBeNull();
  });

  it('sends each role to a page it can open', () => {
    expect(destination('BUYER', '/product/1')).toBe('/product/1');
    expect(destination('BUYER', '/seller-center')).toBe('/');
    expect(destination('BUYER', null)).toBe('/');
    expect(destination('SELLER', '/cart')).toBe('/seller-center');
    expect(destination('SELLER', '/seller-center/orders')).toBe('/seller-center/orders');
  });
});
