import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession, Order, OrderStatus } from '@/lib/types';
import { actionsFor, hint, OrdersPage, tabOf } from '@/pages/shop/OrdersPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };

const order = (id: string, status: OrderStatus, createdAt: string, extra: Partial<Order> = {}): Order => ({
  id,
  shopId: 'shop-1',
  shop: { id: 'shop-1', name: 'Mộc Lan Shop' },
  status,
  createdAt,
  updatedAt: createdAt,
  paidAt: null,
  releaseAt: null,
  cancelReason: null,
  buyerRequestedCancel: false,
  recipient: { name: 'An', phone: '0900000001', addressLine: '12 Lê Lợi', district: 'Quận 1', city: 'Hồ Chí Minh' },
  buyer: { id: 'buyer_1', name: 'An' },
  amounts: { currency: 'VND', productTotalVnd: 258000, sellerDiscountVnd: 0, platformDiscountVnd: 0, subTotalVnd: 258000, shippingFeeVnd: 25000, taxVnd: 0, totalVnd: 283000 },
  items: [{ skuId: `${id}-sku`, productId: 'p', productName: 'Áo thun cotton basic', skuName: 'Trắng / M', sellerSku: 'TEE', unitPriceVnd: 129000, quantity: 2 }],
  ...extra,
});

const orders = [
  order('o1', 'UNPAID', '2026-10-21T05:00:00.000Z'),
  order('o2', 'AWAITING_SHIPMENT', '2026-10-21T04:00:00.000Z'),
  order('o3', 'IN_TRANSIT', '2026-10-21T03:00:00.000Z'),
  // bought from another shop than the buyer's own one (shop-1)
  order('o4', 'DELIVERED', '2026-10-21T02:00:00.000Z', { shopId: 'shop-2', shop: { id: 'shop-2', name: 'Pottery Shop' } }),
  order('o5', 'CANCELLED', '2026-10-21T01:00:00.000Z', { cancelReason: 'Changed mind' }),
];

const fulfillment = (orderId: string, tracking: string) => ({
  orderId,
  orderStatus: 'IN_TRANSIT',
  package: { id: `pkg-${orderId}`, status: 'FULFILLING', trackingNumber: tracking, provider: 'Simulator Express (fake carrier)' },
  blockedReason: null,
  tracking: [
    { status: 'PROCESSING', description: 'Seller has arranged the shipment.', at: '2026-10-21T03:10:00.000Z' },
    { status: 'FULFILLING', description: 'Parcel is in transit.', at: '2026-10-21T04:10:00.000Z' },
  ],
});

const renderOrders = () =>
  render(
    <MemoryRouter initialEntries={['/account/orders']}>
      <AuthProvider>
        <Routes>
          <Route path="/account/orders" element={<OrdersPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe('tab and action rules', () => {
  it('maps every backend status to one tab', () => {
    const expected: Record<OrderStatus, string> = {
      UNPAID: 'to-pay',
      ON_HOLD: 'to-ship',
      AWAITING_SHIPMENT: 'to-ship',
      AWAITING_COLLECTION: 'to-ship',
      PARTIALLY_SHIPPING: 'shipping',
      IN_TRANSIT: 'shipping',
      DELIVERED: 'delivered',
      COMPLETED: 'delivered',
      CANCELLED: 'cancelled',
    };
    for (const [status, tab] of Object.entries(expected)) expect(tabOf(status as OrderStatus)).toBe(tab);
  });

  it('tells the buyer when an ON_HOLD order can ship', () => {
    const held = order('h', 'ON_HOLD', '2026-10-21T05:00:00.000Z', { releaseAt: '2026-10-21T05:30:00.000Z' });
    expect(hint(held)).toMatch(/^Confirming payment · ready to ship after \d{2}\/\d{2}, \d{2}:\d{2}$/);
    expect(hint({ ...held, releaseAt: null })).toBe('Payment received. The order is being confirmed.');
  });

  it('offers the buyer actions per status', () => {
    const a = (status: OrderStatus, buyerRequestedCancel = false) => actionsFor({ status, buyerRequestedCancel });
    expect(a('UNPAID')).toEqual(['cancel', 'pay']);
    expect(a('ON_HOLD')).toEqual(['cancel']);
    expect(a('AWAITING_SHIPMENT')).toEqual(['request-cancel']);
    expect(a('AWAITING_SHIPMENT', true)).toEqual([]);
    expect(a('AWAITING_COLLECTION')).toEqual(['track']);
    expect(a('IN_TRANSIT')).toEqual(['track']);
    expect(a('DELIVERED')).toEqual(['track', 'return']);
    expect(a('COMPLETED')).toEqual(['track', 'return']);
    expect(a('CANCELLED')).toEqual([]);
  });
});

describe('OrdersPage', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url === '/demo/buyer/orders') return json({ items: orders });
        if ((url === '/demo/shops/shop-1/aftersale' || url === '/demo/shops/shop-2/aftersale') && method === 'GET') {
          return json({ items: [], requestReasons: ['CHANGED_MIND', 'DAMAGED_ITEM', 'OTHER'], rejectReasons: [] });
        }
        const f = /\/orders\/(o\d)\/fulfillment$/.exec(url);
        if (f) return json(fulfillment(f[1], `SIM-${f[1]}`));
        if (method === 'POST') return json({}, 201);
        return json({ message: 'nope' }, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const card = (id: string) => screen.getByRole('article', { name: `Order ${id}` });

  it('counts orders per tab and filters by tab', async () => {
    renderOrders();
    expect(await screen.findByRole('tab', { name: 'All (5)' })).toBeTruthy();
    for (const name of ['To pay (1)', 'To ship (1)', 'Shipping (1)', 'Delivered (1)', 'Cancelled (1)']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(5);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Delivered (1)' }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Order o4']);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cancelled (1)' }));
    expect(within(card('o5')).getByText('Cancelled: Changed mind')).toBeTruthy();
  });

  it('lists the orders of every shop and names the shop on each card', async () => {
    renderOrders();
    await screen.findByRole('article', { name: 'Order o1' });
    expect(within(card('o1')).getByText('Mộc Lan Shop')).toBeTruthy();
    expect(within(card('o4')).getByText('Pottery Shop')).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/aftersale')).map((c) => c.url).sort()).toEqual(['/demo/shops/shop-1/aftersale', '/demo/shops/shop-2/aftersale']);
  });

  it('shows the actions of each status on the cards', async () => {
    renderOrders();
    await screen.findByRole('article', { name: 'Order o1' });
    const names = (id: string) => within(card(id)).queryAllByRole('button').map((b) => b.textContent);
    expect(names('o1')).toEqual(['Cancel', 'Pay now']);
    expect(names('o2')).toEqual(['Cancel']);
    expect(names('o3')).toEqual(['Track']);
    expect(names('o4')).toEqual(['Track', 'Request return']);
    expect(names('o5')).toEqual([]);
  });

  it('pays an unpaid order', async () => {
    renderOrders();
    fireEvent.click(within(await screen.findByRole('article', { name: 'Order o1' })).getByRole('button', { name: 'Pay now' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/demo/shops/shop-1/orders/o1/pay', method: 'POST', body: undefined }));
  });

  it('cancels an unpaid order at once and asks the seller for an order awaiting shipment', async () => {
    renderOrders();
    fireEvent.click(within(await screen.findByRole('article', { name: 'Order o1' })).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/demo/shops/shop-1/orders/o1/cancel', method: 'POST', body: { reason: 'Changed mind' } }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(card('o2')).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request cancellation' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Ordered by mistake' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/demo/shops/shop-1/aftersale/cancellations', method: 'POST', body: { orderId: 'o2', reason: 'ORDERED_BY_MISTAKE' } }));
  });

  it('shows tracking of the shipping order, then of the order chosen with Track', async () => {
    renderOrders();
    const panel = await screen.findByRole('region', { name: 'Tracking' });
    expect(await within(panel).findByText('SIM-o3')).toBeTruthy();
    expect(within(panel).getByText('Simulator Express (fake carrier)')).toBeTruthy();
    const timeline = within(panel).getByRole('list', { name: 'Tracking timeline' });
    expect(within(timeline).getAllByRole('listitem')[0].textContent).toContain('Parcel is in transit.');

    fireEvent.click(within(card('o4')).getByRole('button', { name: 'Track' }));
    expect(await within(panel).findByText('SIM-o4')).toBeTruthy();
    // the tracking of an order bought in another shop is read from that shop
    expect(calls).toContainEqual({ url: '/demo/shops/shop-2/orders/o4/fulfillment', method: 'GET', body: undefined });
  });

  it('requests a return with type, reason and items', async () => {
    renderOrders();
    fireEvent.click(within(await screen.findByRole('article', { name: 'Order o4' })).getByRole('button', { name: 'Request return' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request return' });
    const submit = within(dialog).getByRole('button', { name: 'Submit request' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Return and refund' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Damaged item' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Return Áo thun cotton basic (Trắng / M)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Increase quantity' }));
    expect(within(dialog).getByRole('button', { name: 'Increase quantity' }).hasAttribute('disabled')).toBe(true); // bought 2
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: '/demo/shops/shop-2/aftersale/returns',
        method: 'POST',
        body: { orderId: 'o4', items: [{ skuId: 'o4-sku', quantity: 2 }], returnType: 'RETURN_AND_REFUND', reason: 'DAMAGED_ITEM' },
      }),
    );
  });
});
