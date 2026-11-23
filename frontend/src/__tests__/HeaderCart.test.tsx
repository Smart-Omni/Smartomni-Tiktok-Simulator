import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { ShopLayout } from '@/layouts/ShopLayout';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('refreshes the cart quantity badge after a cart update', async () => {
  sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify({ sessionToken: 'buyer-token', role: 'BUYER', shopId: 'shop', buyerId: 'buyer', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  let quantity = 2;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/demo/cart' ? { shops: [{ items: [{ quantity }] }] } : {}), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<MemoryRouter><AuthProvider><ShopLayout /></AuthProvider></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Cart (2)' })).toBeTruthy();
  quantity = 5;
  act(() => { window.dispatchEvent(new Event('shop-cart-updated')); });
  expect(await screen.findByRole('link', { name: 'Cart (5)' })).toBeTruthy();
});
