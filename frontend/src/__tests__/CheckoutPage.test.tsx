import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { CheckoutState } from '@/lib/checkout';
import type { DemoSession, Order } from '@/lib/types';
import { CheckoutPage, validateRecipient } from '@/pages/shop/CheckoutPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };

const cart = {
  currency: 'VND',
  items: [
    { skuId: 'sku-a', productId: 'p-tee', productTitle: 'Áo thun cotton basic', skuName: 'Trắng / M', sellerSku: 'TEE', quantity: 2, unitPriceVnd: 129000, lineTotalVnd: 258000, available: true },
    { skuId: 'sku-b', productId: 'p-mug', productTitle: 'Cốc sứ vẽ tay', skuName: 'Họa tiết xanh', sellerSku: 'MUG', quantity: 1, unitPriceVnd: 89000, lineTotalVnd: 89000, available: true },
  ],
  totalVnd: 347000,
};

// A second shop's line, only in the cart when a test turns `twoShops` on.
const cart2 = {
  currency: 'VND',
  items: [{ skuId: 'sku-z', productId: 'p-vase', productTitle: 'Bình hoa men rạn', skuName: 'Ngà', sellerSku: 'VASE', quantity: 1, unitPriceVnd: 259000, lineTotalVnd: 259000, available: true }],
  totalVnd: 259000,
};

const order = (status: Order['status'], shop = 'shop-1'): Order => ({
  id: shop === 'shop-1' ? '576000111' : '576000222',
  shopId: shop,
  shop: { id: shop, name: shop === 'shop-1' ? 'Mộc Lan Shop' : 'Pottery Shop' },
  status,
  createdAt: future,
  updatedAt: future,
  paidAt: null,
  releaseAt: null,
  cancelReason: null,
  buyerRequestedCancel: false,
  recipient: { name: 'Trần Văn An', phone: '0900000001', addressLine: '12 Lê Lợi', district: 'Quận 1', city: 'Hồ Chí Minh' },
  buyer: { id: 'buyer_1', name: 'Trần Văn An' },
  amounts: { currency: 'VND', productTotalVnd: 129000, sellerDiscountVnd: 12900, platformDiscountVnd: 0, subTotalVnd: 116100, shippingFeeVnd: 25000, taxVnd: 0, totalVnd: 141100 },
  items: [{ skuId: 'sku-a', productId: 'p-tee', productName: 'Áo thun cotton basic', skuName: 'Trắng / M', sellerSku: 'TEE', unitPriceVnd: 129000, quantity: 1 }],
});

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}</output>;
}

const renderCheckout = (state: CheckoutState | null = { items: [{ shopId: 'shop-1', skuId: 'sku-a', quantity: 1 }] }) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/checkout', state }]}>
      <AuthProvider>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="*" element={null} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('CheckoutPage', () => {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let checkoutError: { code: string; message: string } | null;
  let twoShops: boolean;
  beforeEach(() => {
    calls.length = 0;
    checkoutError = null;
    twoShops = false;
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === '/demo/cart') {
          const shops = [{ shop: { id: 'shop-1', name: 'Mộc Lan Shop' }, items: cart.items, shopTotalVnd: cart.totalVnd }];
          if (twoShops) shops.push({ shop: { id: 'shop-2', name: 'Pottery Shop' }, items: cart2.items, shopTotalVnd: cart2.totalVnd });
          return json({ currency: 'VND', shops, totalVnd: shops.reduce((n, g) => n + g.shopTotalVnd, 0), itemCount: 3 });
        }
        if (url === '/demo/catalog?limit=100') return json({ currency: 'VND', items: [], nextCursor: null });
        if (url === '/demo/me') return json({ role: 'BUYER', shop: { id: 'shop-1', name: 'Mộc Lan Shop' }, buyer: { id: 'buyer_1', name: 'Trần Văn An', city: 'Hồ Chí Minh' } });
        if (url === '/demo/shops/shop-1/coupons') {
          return json({
            items: [
              { id: 'v1', title: 'Ten off', promoCode: 'SALE10', status: 'ONGOING', discountText: '10% off', minSpendVnd: 100000 },
              { id: 'v2', title: 'Old', promoCode: 'OLD2020', status: 'EXPIRED', discountText: '5% off', minSpendVnd: null },
            ],
          });
        }
        if (url === '/demo/shops/shop-2/coupons') return json({ items: [] });
        if (url === '/demo/shops/shop-1/checkout') {
          if (checkoutError) return json(checkoutError, 400);
          return json({ replayed: false, order: order('UNPAID') }, 201);
        }
        if (url === '/demo/shops/shop-2/checkout') return json({ replayed: false, order: order('UNPAID', 'shop-2') }, 201);
        if (url === '/demo/shops/shop-1/cart/items') return json(cart);
        if (url === '/demo/shops/shop-2/cart/items') return json(cart2);
        if (url === '/demo/shops/shop-1/orders/576000111/pay') return json({ replayed: false, order: order('ON_HOLD') }, 201);
        if (url === '/demo/shops/shop-2/orders/576000222/pay') return json({ replayed: false, order: order('ON_HOLD', 'shop-2') }, 201);
        return json({ message: 'nope' }, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const posts = (path: string, shop = 'shop-1') => calls.filter((c) => c.method === 'POST' && c.url === `/demo/shops/${shop}${path}`);

  it('places the order, shows the real amounts, then pays and opens My orders', async () => {
    renderCheckout();
    const items = await screen.findByRole('list', { name: 'Items from Mộc Lan Shop' });
    expect(within(items).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('total').textContent).toBe('₫129.000');

    fireEvent.change(screen.getByLabelText('Message to seller'), { target: { value: 'Please wrap it' } });
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'SALE10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByText('Order placed · UNPAID')).toBeTruthy();
    expect(screen.getByTestId('total').textContent).toBe('₫141.100');
    expect(screen.getByText('-₫12.900')).toBeTruthy();
    expect(screen.getByText('₫25.000')).toBeTruthy();
    const [placed] = posts('/checkout');
    expect(placed.body).toMatchObject({ items: [{ skuId: 'sku-a', quantity: 1 }], buyerMessage: 'Please wrap it', couponCode: 'SALE10' });
    expect(String(placed.body?.checkoutKey).length).toBeGreaterThanOrEqual(8);
    expect(placed.body).not.toHaveProperty('recipient');
    // 2 in the cart, 1 bought
    await waitFor(() => expect(calls).toContainEqual({ url: '/demo/shops/shop-1/cart/items', method: 'PUT', body: { skuId: 'sku-a', quantity: 1 } }));

    fireEvent.click(screen.getByRole('button', { name: 'Pay now (simulated)' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/account/orders'));
    expect(posts('/orders/576000111/pay')).toHaveLength(1);
  });

  it('shows a voucher error under the voucher field and retries with the same checkout key', async () => {
    checkoutError = { code: 'coupon_expired', message: 'This voucher has expired' };
    renderCheckout();
    fireEvent.change(await screen.findByLabelText('Voucher code'), { target: { value: 'OLD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    const error = await screen.findByText('This voucher has expired');
    expect(screen.getByLabelText('Voucher code').getAttribute('aria-describedby')).toBe(error.id);
    expect(screen.queryByText(/Order placed/)).toBeNull();

    checkoutError = null;
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Order placed · UNPAID')).toBeTruthy();
    const [first, second] = posts('/checkout');
    expect(second.body?.checkoutKey).toBe(first.body?.checkoutKey);
    expect(second.body).not.toHaveProperty('couponCode');
  });

  it('shows a stock error under the items', async () => {
    checkoutError = { code: 'insufficient_stock', message: 'Not enough stock for Trắng / M' };
    renderCheckout();
    fireEvent.click(await screen.findByRole('button', { name: 'Place order' }));
    const error = await screen.findByText('Not enough stock for Trắng / M');
    expect(within(screen.getByRole('region', { name: 'Mộc Lan Shop' })).getByText('Not enough stock for Trắng / M')).toBe(error);
  });

  it('sends a recipient entered in the Change dialog, after validating it', async () => {
    renderCheckout();
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save address' }));
    expect(within(dialog).getByText('At least 5 characters.')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '0911222333' } });
    fireEvent.change(within(dialog).getByLabelText('Address line'), { target: { value: '3 Hai Bà Trưng' } });
    fireEvent.change(within(dialog).getByLabelText('District'), { target: { value: 'Hoàn Kiếm' } });
    fireEvent.change(within(dialog).getByLabelText('City'), { target: { value: 'Hà Nội' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('address').textContent).toContain('3 Hai Bà Trưng, Hoàn Kiếm, Hà Nội');

    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText('Order placed · UNPAID');
    expect(posts('/checkout')[0].body?.recipient).toEqual({ name: 'Trần Văn An', phone: '0911222333', addressLine: '3 Hai Bà Trưng', district: 'Hoàn Kiếm', city: 'Hà Nội', postalCode: null });
  });

  it('offers the ongoing vouchers as chips and upper-cases a typed code', async () => {
    renderCheckout();
    const chips = await screen.findByRole('group', { name: 'Available vouchers' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['SALE1010% off']);
    fireEvent.click(within(chips).getByRole('button'));
    expect((screen.getByLabelText('Voucher code') as HTMLInputElement).value).toBe('SALE10');
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'e2eoff50' } });
    expect((screen.getByLabelText('Voucher code') as HTMLInputElement).value).toBe('E2EOFF50');
  });

  it('places one order per shop with its own key, message and voucher, then pays both', async () => {
    twoShops = true;
    renderCheckout({ items: [{ shopId: 'shop-1', skuId: 'sku-a', quantity: 1 }, { shopId: 'shop-2', skuId: 'sku-z', quantity: 1 }] });
    await screen.findByRole('list', { name: 'Items from Mộc Lan Shop' });
    expect(screen.getByRole('list', { name: 'Items from Pottery Shop' })).toBeTruthy();
    expect(screen.getByTestId('total').textContent).toBe('₫388.000');
    const [msg1, msg2] = screen.getAllByLabelText('Message to seller');
    fireEvent.change(msg1, { target: { value: 'for shop one' } });
    fireEvent.change(msg2, { target: { value: 'for shop two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByText('2 orders placed')).toBeTruthy();
    const [one] = posts('/checkout');
    const [two] = posts('/checkout', 'shop-2');
    expect(one.body).toMatchObject({ items: [{ skuId: 'sku-a', quantity: 1 }], buyerMessage: 'for shop one' });
    expect(two.body).toMatchObject({ items: [{ skuId: 'sku-z', quantity: 1 }], buyerMessage: 'for shop two' });
    expect(two.body?.checkoutKey).not.toBe(one.body?.checkoutKey);
    // the total is the sum of both orders
    expect(screen.getByTestId('total').textContent).toBe('₫282.200');

    fireEvent.click(screen.getByRole('button', { name: 'Pay now (simulated)' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/account/orders'));
    expect(posts('/orders/576000111/pay')).toHaveLength(1);
    expect(posts('/orders/576000222/pay', 'shop-2')).toHaveLength(1);
  });

  it('keeps the placed order when another shop fails and places only the rest on retry', async () => {
    twoShops = true;
    checkoutError = { code: 'insufficient_stock', message: 'Not enough stock for Trắng / M' };
    renderCheckout({ items: [{ shopId: 'shop-1', skuId: 'sku-a', quantity: 1 }, { shopId: 'shop-2', skuId: 'sku-z', quantity: 1 }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/Order placed/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Mộc Lan Shop' })).getByText('Not enough stock for Trắng / M')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay now (simulated)' })).toBeNull();

    checkoutError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Place remaining orders' }));
    expect(await screen.findByText('2 orders placed')).toBeTruthy();
    expect(posts('/checkout', 'shop-2')).toHaveLength(1); // not placed twice
  });

  it('uses the available cart lines when opened without a selection', async () => {
    renderCheckout(null);
    const items = await screen.findByRole('list', { name: 'Items from Mộc Lan Shop' });
    expect(within(items).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('total').textContent).toBe('₫347.000');
  });
});

describe('validateRecipient', () => {
  it('applies the checkout schema limits', () => {
    expect(validateRecipient({ name: 'A', phone: '12345', addressLine: 'x', district: 'y', city: 'z' })).toEqual({});
    expect(validateRecipient({ name: ' ', phone: '1234', addressLine: 'x', district: 'y', city: 'z', postalCode: '1'.repeat(21) })).toEqual({
      name: 'Required.',
      phone: 'At least 5 characters.',
      postalCode: 'At most 20 characters.',
    });
  });
});
