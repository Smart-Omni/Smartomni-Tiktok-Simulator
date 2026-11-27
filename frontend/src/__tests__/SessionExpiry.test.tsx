import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireRole } from '@/components/RequireRole';
import { SessionExpiryWatcher } from '@/components/SessionExpiryWatcher';
import { api } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession } from '@/lib/types';

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };
const seller: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };
const EXPIRED = 'Your session has expired. Please sign in again.';

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <SessionExpiryWatcher />
        <Routes>
          <Route element={<RequireRole role="BUYER" />}>
            <Route path="/account/orders" element={null} />
          </Route>
          <Route element={<RequireRole role="SELLER" />}>
            <Route path="/seller-center/orders" element={null} />
          </Route>
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );

/** Runs api() and ignores the ApiError it still throws. */
const call = (path: string, demoSession?: string) => act(() => api(path, { demoSession }).then(() => undefined, () => undefined));
const location = () => screen.getByTestId('location').textContent;

describe('SessionExpiryWatcher', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(seller));
    vi.spyOn(toast, 'error').mockImplementation(() => 0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Session expired' }), { status: 401 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('signs the buyer out once and sends them to sign in with the current page as next', async () => {
    renderAt('/account/orders?tab=to-ship');
    await call('/demo/me', 'tok-b');
    await call('/demo/shops/shop-1/cart', 'tok-b');
    await waitFor(() => expect(location()).toBe('/login?next=%2Faccount%2Forders%3Ftab%3Dto-ship'));
    expect(sessionStorage.getItem('sim.demo-session.BUYER')).toBeNull();
    expect(sessionStorage.getItem('sim.demo-session.SELLER')).not.toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(EXPIRED);
  });

  it('opens the seller sign-in for an expired seller session', async () => {
    renderAt('/seller-center/orders');
    await call('/demo/shops/shop-1/orders', 'tok-s');
    await waitFor(() => expect(location()).toBe('/login?next=%2Fseller-center%2Forders&role=seller'));
    expect(sessionStorage.getItem('sim.demo-session.SELLER')).toBeNull();
    expect(sessionStorage.getItem('sim.demo-session.BUYER')).not.toBeNull();
  });

  it('keeps an expired buyer on a public page', async () => {
    renderAt('/product/shop-1/7500T');
    await call('/demo/shops/shop-1/cart', 'tok-b');
    await waitFor(() => expect(sessionStorage.getItem('sim.demo-session.BUYER')).toBeNull());
    expect(location()).toBe('/product/shop-1/7500T');
    expect(toast.error).toHaveBeenCalledWith(EXPIRED);
  });

  it('ignores 401 from /test-admin and from requests without a demo session', async () => {
    renderAt('/console');
    await call('/test-admin/status', 'tok-b');
    await call('/demo/identities');
    expect(location()).toBe('/console');
    expect(sessionStorage.getItem('sim.demo-session.BUYER')).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
