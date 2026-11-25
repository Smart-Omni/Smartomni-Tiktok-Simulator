import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { DemoSession } from '@/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const sellerSession: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };
const identities = { sellers: [{ id: 'seller_1', name: 'Seller One', shops: [{ id: 'shop-1', name: 'Demo Shop VN' }] }], buyers: [] };

const consent = { app: { appKey: 'k', name: 'SmartOmni (dev)' }, shop: { id: 'shop-1', name: 'Demo Shop VN', region: 'VN', currency: 'VND' }, scopes: [], redirectUri: 'http://localhost:8080/cb', state: 's' };

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Location />
    </MemoryRouter>,
  );

describe('routes', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/demo/identities' ? json(identities) : url.startsWith('/demo/authorization/consent') ? json(consent) : json({}))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a guest from the OAuth consent page to the seller sign-in', async () => {
    renderAt('/seller/authorize?app_key=k&state=s');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fseller%2Fauthorize%3Fapp_key%3Dk%26state%3Ds&role=seller'), { timeout: 10_000 });
  });

  it('keeps the simulator topbar on the OAuth consent page, with links to the new UI', async () => {
    localStorage.setItem('sim.demo-session.SELLER', JSON.stringify(sellerSession));
    renderAt('/seller/authorize?app_key=k&state=s');
    expect(screen.getByText('TikTok Shop Simulator')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Authorize app' })).toBeTruthy();
    const nav = screen.getByRole('banner');
    expect(within(nav).getByRole('link', { name: 'Tiptop Shop' }).getAttribute('href')).toBe('/');
    expect(within(nav).getByRole('link', { name: 'Seller Center' }).getAttribute('href')).toBe('/seller-center');
    expect(within(nav).getByRole('link', { name: 'Test Console' }).getAttribute('href')).toBe('/console');
  });

  it('sends links of the removed /buyer and /seller pages to the new UI', () => {
    renderAt('/buyer/product/sim-product-a-tee');
    expect(screen.getByTestId('location').textContent).toBe('/product/sim-product-a-tee');
    cleanup();
    renderAt('/buyer/orders/123');
    expect(screen.getByTestId('location').textContent).toBe('/');
    cleanup();
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(sellerSession));
    renderAt('/seller/coupons');
    expect(screen.getByTestId('location').textContent).toBe('/seller-center');
  });

  it('renders the new shop layout without the legacy topbar', async () => {
    renderAt('/');
    expect(await screen.findByRole('region', { name: 'Products' })).toBeTruthy();
    expect(screen.queryByText('TikTok Shop Simulator')).toBeNull();
    expect(within(screen.getByRole('banner')).getByRole('search')).toBeTruthy();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2F');
  });

  it('sends a guest from a buyer-only page to /login with next', () => {
    renderAt('/cart');
    expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fcart');
  });

  it('sends a guest from Seller Center to the seller sign-in', () => {
    renderAt('/seller-center/orders');
    expect(screen.getByTestId('location').textContent).toBe('/login?next=%2Fseller-center%2Forders&role=seller');
  });

  it('shows the Seller Center menu with a seller session', async () => {
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(sellerSession));
    renderAt('/seller-center/orders');
    expect(await screen.findByRole('navigation', { name: 'Seller Center' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage orders' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('Demo Shop VN')).toBeTruthy();
  });
});
