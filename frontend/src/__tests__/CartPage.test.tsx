import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { Cart, CartItem, DemoSession, MarketplaceCart, StorefrontProduct } from '@/lib/types';
import { CartPage } from '@/pages/shop/CartPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };

const line = (skuId: string, productId: string, productTitle: string, skuName: string, unitPriceVnd: number, quantity: number, available = true): CartItem => ({
  skuId, productId, productTitle, skuName, sellerSku: skuId, quantity, unitPriceVnd, lineTotalVnd: unitPriceVnd * quantity, available,
});
const SHOP_NAMES: Record<string, string> = { 'shop-1': 'Mộc Lan Shop', 'shop-2': 'Pottery Shop' };
const product = (id: string, title: string, skus: { id: string; stock: number }[], shop = 'shop-1'): StorefrontProduct => ({
  shop: { id: shop, name: SHOP_NAMES[shop] }, id, title, description: '', imageUrl: `/img/${id}.svg`, minPriceVnd: 1, maxPriceVnd: 1,
  skus: skus.map((s) => ({ id: s.id, name: s.id, attributeName: 'V', priceVnd: 1, available: true, stock: s.stock })),
});

const TEE = 'Áo thun cotton basic (Trắng / M)';
const MUG = 'Cốc sứ vẽ tay (Họa tiết xanh)';
const CASE = 'Ốp lưng cũ (Đen)';

/** The lines of both shops; the mug is sold by shop-2, the rest by shop-1. */
let cartItems: (CartItem & { shop: string })[];
const cartOf = (items: CartItem[]): Cart => ({ currency: 'VND', items, totalVnd: items.reduce((n, l) => n + l.lineTotalVnd, 0) });
const inShopCart = (id: string) => cartOf(cartItems.filter((l) => l.shop === id));
const marketCart = (): MarketplaceCart => {
  const shops = Object.keys(SHOP_NAMES).flatMap((id) => {
    const items = cartItems.filter((l) => l.shop === id);
    return items.length ? [{ shop: { id, name: SHOP_NAMES[id] }, items, shopTotalVnd: items.reduce((n, l) => n + l.lineTotalVnd, 0) }] : [];
  });
  return { currency: 'VND', shops, totalVnd: shops.reduce((n, g) => n + g.shopTotalVnd, 0), itemCount: cartItems.reduce((n, l) => n + l.quantity, 0) };
};

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}</output>;
}
let lastState: unknown;
function StateProbe() {
  lastState = useLocation().state;
  return null;
}

const renderCart = () =>
  render(
    <MemoryRouter initialEntries={['/cart']}>
      <AuthProvider>
        <Routes>
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<StateProbe />} />
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('CartPage', () => {
  const puts: unknown[] = [];
  /** Lets a test hold the PUT response to look at the optimistic state. */
  let putGate: Promise<void> | null;
  let putFails: boolean;
  beforeEach(() => {
    puts.length = 0;
    putGate = null;
    putFails = false;
    lastState = undefined;
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    cartItems = [
      { ...line('sku-a', 'p-tee', 'Áo thun cotton basic', 'Trắng / M', 129000, 1), shop: 'shop-1' },
      { ...line('sku-b', 'p-mug', 'Cốc sứ vẽ tay', 'Họa tiết xanh', 89000, 2), shop: 'shop-2' },
      { ...line('sku-c', 'p-case', 'Ốp lưng cũ', 'Đen', 79000, 1, false), shop: 'shop-1' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url === '/demo/cart') return json(marketCart());
        if (url === '/demo/catalog?limit=100') {
          return json({
            currency: 'VND',
            items: [product('p-tee', 'Áo thun cotton basic', [{ id: 'sku-a', stock: 3 }]), product('p-mug', 'Cốc sứ vẽ tay', [{ id: 'sku-b', stock: 5 }], 'shop-2')],
            nextCursor: null,
          });
        }
        const put = /^\/demo\/shops\/(shop-\d)\/cart\/items$/.exec(url);
        if (put && method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as { skuId: string; quantity: number };
          puts.push({ shop: put[1], ...body });
          if (putGate) await putGate;
          if (putFails) return json({ message: 'Not enough stock' }, 400);
          cartItems = cartItems.flatMap((l) => (l.skuId !== body.skuId ? [l] : body.quantity === 0 ? [] : [{ ...l, quantity: body.quantity, lineTotalVnd: l.unitPriceVnd * body.quantity }]));
          return json(inShopCart(put[1]));
        }
        return json({}, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const qty = (name: string) => (screen.getByRole('spinbutton', { name: `Quantity of ${name}` }) as HTMLInputElement).value;
  const lineEl = (name: string) => screen.getByRole('listitem', { name });
  const checkoutButton = () => screen.getByRole('button', { name: /^Check out/ }) as HTMLButtonElement;

  describe('selection', () => {
    it('selects every available line by default and leaves unavailable lines out', async () => {
      renderCart();
      expect(await screen.findByRole('heading', { name: 'Cart (3)' })).toBeTruthy();
      expect(checkoutButton().textContent).toBe('Check out (2)');
      expect(screen.getByTestId('total').textContent).toBe('₫307.000');
      const unavailable = lineEl(CASE);
      expect(within(unavailable).getByText('No longer available')).toBeTruthy();
      expect(within(unavailable).queryByRole('checkbox')).toBeNull();
      expect(within(unavailable).queryByRole('spinbutton')).toBeNull();
      expect(within(unavailable).getByRole('button', { name: 'Remove' })).toBeTruthy();
    });

    it('updates the summary when lines are unticked, and Select all toggles them', async () => {
      renderCart();
      fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${MUG}` }));
      expect(checkoutButton().textContent).toBe('Check out (1)');
      expect(screen.getByTestId('total').textContent).toBe('₫129.000');
      expect(screen.getByText('Items (1)')).toBeTruthy();

      const selectAll = screen.getByRole('checkbox', { name: 'Select all (2)' });
      expect(selectAll.getAttribute('aria-checked')).toBe('mixed');
      fireEvent.click(selectAll);
      expect(checkoutButton().textContent).toBe('Check out (2)');
      fireEvent.click(selectAll);
      expect(checkoutButton().textContent).toBe('Check out (0)');
      expect(checkoutButton().disabled).toBe(true);
    });

    it('checks out only the selected lines', async () => {
      renderCart();
      fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${TEE}` }));
      fireEvent.click(checkoutButton());
      expect(screen.getByTestId('location').textContent).toBe('/checkout');
      expect(lastState).toEqual({ items: [{ shopId: 'shop-2', skuId: 'sku-b', quantity: 2 }] });
    });
  });

  describe('shops', () => {
    it('groups the lines by shop, each with its own select all', async () => {
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      expect(within(screen.getByRole('region', { name: 'Mộc Lan Shop' })).getAllByRole('listitem')).toHaveLength(2);
      expect(within(screen.getByRole('region', { name: 'Pottery Shop' })).getAllByRole('listitem')).toHaveLength(1);
      expect(screen.getByText('Items from different shops are placed as separate orders.')).toBeTruthy();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select all from Pottery Shop' }));
      expect(checkoutButton().textContent).toBe('Check out (1)');
      expect(screen.queryByText('Items from different shops are placed as separate orders.')).toBeNull();
    });

    it('links each line to the product page of its own shop', async () => {
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      const links = within(lineEl(MUG)).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['/product/shop-2/p-mug', '/product/shop-2/p-mug']);
    });

    it('checks out the lines of both shops together', async () => {
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      fireEvent.click(checkoutButton());
      expect(lastState).toEqual({
        items: [
          { shopId: 'shop-1', skuId: 'sku-a', quantity: 1 },
          { shopId: 'shop-2', skuId: 'sku-b', quantity: 2 },
        ],
      });
    });
  });

  describe('stepper', () => {
    it('shows the new quantity right away and sends it with PUT cart/items', async () => {
      let open!: () => void;
      putGate = new Promise((r) => (open = r));
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      fireEvent.click(within(lineEl(TEE)).getByRole('button', { name: 'Increase quantity' }));
      expect(qty(TEE)).toBe('2'); // before the server answered
      expect(screen.getByTestId('total').textContent).toBe('₫436.000');
      expect(puts).toEqual([{ shop: 'shop-1', skuId: 'sku-a', quantity: 2 }]);
      await act(async () => open());
      await waitFor(() => expect((within(lineEl(TEE)).getByRole('button', { name: 'Increase quantity' }) as HTMLButtonElement).disabled).toBe(false));
      expect(qty(TEE)).toBe('2');
    });

    it('rolls back when the update fails', async () => {
      putFails = true;
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      fireEvent.click(within(lineEl(MUG)).getByRole('button', { name: 'Increase quantity' }));
      expect(qty(MUG)).toBe('3');
      await waitFor(() => expect(qty(MUG)).toBe('2'));
    });

    it('stops at the SKU stock', async () => {
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      const plus = within(lineEl(TEE)).getByRole('button', { name: 'Increase quantity' }) as HTMLButtonElement;
      fireEvent.click(plus);
      await waitFor(() => expect(plus.disabled).toBe(false));
      fireEvent.click(plus);
      await waitFor(() => expect(qty(TEE)).toBe('3'));
      await waitFor(() => expect(puts).toHaveLength(2));
      expect(plus.disabled).toBe(true); // stock is 3
    });

    it('removes a line with quantity 0', async () => {
      renderCart();
      await screen.findByRole('heading', { name: 'Cart (3)' });
      fireEvent.click(screen.getByRole('button', { name: `Remove ${MUG}` }));
      expect(screen.queryByRole('listitem', { name: MUG })).toBeNull();
      expect(puts).toEqual([{ shop: 'shop-2', skuId: 'sku-b', quantity: 0 }]);
      expect(await screen.findByRole('heading', { name: 'Cart (2)' })).toBeTruthy();
    });
  });

  it('shows an empty state with Continue shopping', async () => {
    cartItems = [];
    renderCart();
    expect((await screen.findByRole('link', { name: 'Continue shopping' })).getAttribute('href')).toBe('/');
  });
});
