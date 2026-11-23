import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { toast } from 'sonner';
import { ProductCard } from '@/components/shop/ProductCard';
import { shopPrice } from '@/lib/format';
import type { EnrichedProduct } from '@/mocks';

const product: EnrichedProduct = {
  id: '7500 1',
  title: 'Oversized cotton tee',
  description: '',
  imageUrl: '',
  minPriceVnd: 129000,
  maxPriceVnd: 135000,
  skus: [],
  originalPriceVnd: 199000,
  discountPct: 35,
  rating: 4.8,
  sold: 2400,
  trending: false,
  imageBg: '#FDE2E4',
};

describe('ProductCard', () => {
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('opens quick add and submits the chosen variant to its own shop cart', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(1);
    const updated = vi.fn();
    window.addEventListener('shop-cart-updated', updated, { once: true });
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify({ sessionToken: 'buyer-token', role: 'BUYER', shopId: 'own-shop', buyerId: 'buyer', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ items: [], totalVnd: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const item = { ...product, shop: { id: 'selling-shop', name: 'Shop' }, skus: [
      { id: 'small', name: 'Small', attributeName: 'Size', priceVnd: 129000, stock: 3, available: true },
      { id: 'large', name: 'Large', attributeName: 'Size', priceVnd: 135000, stock: 5, available: true },
    ] };
    render(<MemoryRouter><AuthProvider><ProductCard product={item} compact /></AuthProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: `Quick add ${item.title}` }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('radio', { name: 'Large' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Increase quantity' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/demo/shops/selling-shop/cart/items', body: { skuId: 'large', quantity: 2 } }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Added to cart', { duration: 2500, className: 'shop-cart-toast' }));
    expect(updated).toHaveBeenCalledOnce();
    expect(dialog.queryByText('Added to cart.')).toBeNull();
  });

  it('shows price, discount, rating and sold count, linking to the product page', () => {
    render(<MemoryRouter><ProductCard product={product} /></MemoryRouter>);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/product/7500%201');
    expect(screen.getByText('₫129.000')).toBeTruthy();
    expect(screen.getByText('-35%')).toBeTruthy();
    expect(screen.getByText('4.8')).toBeTruthy();
    expect(screen.getByText('2.4K sold')).toBeTruthy();
  });

  it('hides the discount badge when there is none, and never shows a mock free-shipping badge', () => {
    render(<MemoryRouter><ProductCard product={{ ...product, discountPct: 0 }} /></MemoryRouter>);
    expect(screen.queryByText(/^-\d+%$/)).toBeNull();
    expect(screen.queryByText('Free shipping')).toBeNull();
  });

  it('formats prices like the boards', () => {
    expect(shopPrice(1250000)).toBe('₫1.250.000');
  });
});
