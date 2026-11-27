import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { sellerActionsFor, sellerTabOf } from '@/lib/sellerOrders';
import type { DemoSession, Order, OrderHistoryEntry, OrderStatus } from '@/lib/types';
import { orderProgress, SellerOrderDetail } from '@/pages/seller-center/SellerOrderDetail';
import { SellerOrders } from '@/pages/seller-center/SellerOrders';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 24 * 3600_000).toISOString();
const seller: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };

const order = (id: string, status: OrderStatus, hour: number, buyer = 'Lê Thu Hà', extra: Partial<Order> = {}): Order => ({
  id,
  status,
  createdAt: `2026-10-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
  updatedAt: `2026-10-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
  paidAt: null,
  cancelReason: null,
  buyerRequestedCancel: false,
  recipient: { name: buyer, phone: '0900000002', addressLine: '45 Trần Phú', district: 'Hà Đông', city: 'Hà Nội' },
  buyer: { id: 'b', name: buyer },
  amounts: { currency: 'VND', productTotalVnd: 258000, sellerDiscountVnd: 25800, platformDiscountVnd: 0, subTotalVnd: 232200, shippingFeeVnd: 25000, taxVnd: 0, totalVnd: 257200 },
  items: [{ skuId: 's1', productId: 'p1', productName: 'Áo thun cotton basic', skuName: 'Trắng / M', sellerSku: 'TEE-WHT-M', unitPriceVnd: 129000, quantity: 2 }],
  ...extra,
});

const orders = [
  order('o1', 'UNPAID', 1),
  order('o2', 'AWAITING_SHIPMENT', 2, 'Lê Thu Hà'),
  order('o3', 'AWAITING_SHIPMENT', 3, 'Trần Văn An'),
  order('o4', 'AWAITING_COLLECTION', 4),
  order('o5', 'IN_TRANSIT', 5, 'Lê Thu Hà', { paidAt: '2026-10-21T05:05:00.000Z' }),
  order('o6', 'DELIVERED', 6),
  order('o7', 'CANCELLED', 7),
];
const history: OrderHistoryEntry[] = [
  { from: null, to: 'UNPAID', actor: 'BUYER', note: 'checkout', at: '2026-10-21T05:00:00.000Z' },
  { from: 'UNPAID', to: 'AWAITING_SHIPMENT', actor: 'BUYER', note: 'fake payment', at: '2026-10-21T05:05:00.000Z' },
  { from: 'AWAITING_SHIPMENT', to: 'AWAITING_COLLECTION', actor: 'SELLER', note: 'arrange shipment', at: '2026-10-21T06:00:00.000Z' },
  { from: 'AWAITING_COLLECTION', to: 'IN_TRANSIT', actor: 'SYSTEM', note: 'carrier collected', at: '2026-10-21T07:00:00.000Z' },
];
const fulfillment = (orderId: string) => ({
  orderId,
  orderStatus: 'IN_TRANSIT',
  package: { id: `pkg-${orderId}`, status: 'FULFILLING', trackingNumber: `SIM-${orderId}`, provider: 'Simulator Express (fake carrier)' },
  canArrange: false,
  blockedReason: null,
  tracking: [],
});

describe('seller order rules', () => {
  it('maps every status to one tab', () => {
    const expected: Record<OrderStatus, string> = {
      UNPAID: 'unpaid',
      AWAITING_SHIPMENT: 'to-ship',
      AWAITING_COLLECTION: 'to-ship',
      PARTIALLY_SHIPPING: 'shipped',
      IN_TRANSIT: 'shipped',
      DELIVERED: 'completed',
      COMPLETED: 'completed',
      CANCELLED: 'cancelled',
    };
    for (const [status, tab] of Object.entries(expected)) expect(sellerTabOf(status as OrderStatus)).toBe(tab);
  });

  it('offers the actions of each status', () => {
    expect(sellerActionsFor('UNPAID', false)).toEqual(['cancel']);
    expect(sellerActionsFor('AWAITING_SHIPMENT', false)).toEqual(['arrange', 'cancel']);
    expect(sellerActionsFor('AWAITING_COLLECTION', true)).toEqual(['label', 'advance']);
    expect(sellerActionsFor('AWAITING_COLLECTION', false)).toEqual(['advance']);
    expect(sellerActionsFor('IN_TRANSIT', true)).toEqual(['label', 'advance']);
    expect(sellerActionsFor('DELIVERED', true)).toEqual(['label']);
    expect(sellerActionsFor('COMPLETED', true)).toEqual(['label']);
    expect(sellerActionsFor('CANCELLED', true)).toEqual([]);
  });

  it('places the order on the progress bar, also when cancelled', () => {
    expect(orderProgress(orders[4], history)).toMatchObject({ current: 3, cancelled: false });
    expect(orderProgress(orders[4], history).at[1]).toBe('2026-10-21T05:05:00.000Z');
    const cancelled = orderProgress(order('x', 'CANCELLED', 1), [history[0], history[1], { from: 'AWAITING_SHIPMENT', to: 'CANCELLED', actor: 'SELLER', note: 'Out of stock', at: '2026-10-21T06:00:00.000Z' }]);
    expect(cancelled).toMatchObject({ current: 1, cancelled: true });
    // history written before ON_HOLD was removed still counts as paid (DECISIONS H12)
    const legacy = orderProgress(order('y', 'CANCELLED', 1), [
      history[0],
      { from: 'UNPAID', to: 'ON_HOLD', actor: 'BUYER', note: 'fake payment', at: '2026-10-21T05:05:00.000Z' },
      { from: 'ON_HOLD', to: 'CANCELLED', actor: 'BUYER', note: 'x', at: '2026-10-21T05:10:00.000Z' },
    ]);
    expect(legacy).toMatchObject({ current: 1, cancelled: true });
  });
});

describe('Seller Center orders', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(seller));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        const base = '/demo/shops/shop-1';
        if (url === `${base}/orders`) return json({ items: orders });
        if (url === `${base}/orders/o5`) return json({ order: orders[4], history });
        const f = /\/orders\/(o\d)\/fulfillment$/.exec(url);
        if (f) return json(fulfillment(f[1]));
        if (url.endsWith('/shipping-label')) return json({ documentType: 'SHIPPING_LABEL', trackingNumber: 'SIM-o4', url: 'http://localhost:8090/demo/files/shipping-documents/abc.pdf' }, 201);
        if (method === 'POST') return json({}, 201);
        return json({ message: 'Not found' }, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/seller-center/orders" element={<SellerOrders />} />
            <Route path="/seller-center/orders/:id" element={<SellerOrderDetail />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
  const row = (id: string) => screen.getByRole('row', { name: `Order ${id}` });
  /** Seller actions only: the TEST Force status menu is checked on its own. */
  const buttons = (el: HTMLElement) => within(el).queryAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Force status');
  const forced = (el: HTMLElement) => within(el).queryAllByRole('button', { name: /^Force status of / }).length === 1;

  it('counts per tab, opens the tab from ?tab= and filters by order ID or buyer name', async () => {
    renderAt('/seller-center/orders?tab=to-ship');
    expect(await screen.findByRole('tab', { name: 'All (7)' })).toBeTruthy();
    for (const name of ['Unpaid (1)', 'Shipped (1)', 'Completed (1)', 'Cancelled (1)']) expect(screen.getByRole('tab', { name })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'To ship (3)' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('row', { name: /^Order / }).map((r) => r.getAttribute('aria-label'))).toEqual(['Order o4', 'Order o3', 'Order o2']);

    const filter = screen.getByRole('textbox', { name: 'Filter by order ID or buyer name' });
    fireEvent.change(filter, { target: { value: 'tran van' } });
    expect(screen.getAllByRole('row', { name: /^Order / }).map((r) => r.getAttribute('aria-label'))).toEqual(['Order o3']);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'All (7)' }));
    fireEvent.change(filter, { target: { value: 'O6' } });
    expect(screen.getAllByRole('row', { name: /^Order / }).map((r) => r.getAttribute('aria-label'))).toEqual(['Order o6']);
  });

  it('shows the actions of each status in the table', async () => {
    renderAt('/seller-center/orders');
    await screen.findByRole('row', { name: 'Order o1' });
    await waitFor(() => expect(within(row('o4')).getByText('SIM-o4')).toBeTruthy());
    await waitFor(() => expect(within(row('o6')).getByText('SIM-o6')).toBeTruthy());
    expect(buttons(row('o1'))).toEqual(['Cancel order']);
    expect(buttons(row('o2'))).toEqual(['Arrange shipment', 'Cancel order']);
    expect(buttons(row('o3'))).toEqual(['Arrange shipment', 'Cancel order']);
    expect(buttons(row('o4'))).toEqual(['Print label', 'Simulate carrier']);
    expect(buttons(row('o5'))).toEqual(['Print label', 'Simulate carrier']);
    expect(buttons(row('o6'))).toEqual(['Print label']);
    expect(buttons(row('o7'))).toEqual([]);
    // TEST Force status on every order that can still move; none on the cancelled one
    expect(['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].every((id) => forced(row(id)))).toBe(true);
    expect(forced(row('o7'))).toBe(false);
  });

  it('arranges, simulates the carrier, cancels with a reason and prints the label', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderAt('/seller-center/orders');
    await screen.findByRole('row', { name: 'Order o3' });
    const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === `/demo/shops/shop-1/orders/${path}`);

    fireEvent.click(within(row('o3')).getByRole('button', { name: 'Arrange shipment' }));
    await waitFor(() => expect(posted('o3/arrange-shipment')).toHaveLength(1));

    await waitFor(() => expect(within(row('o4')).getByRole('button', { name: 'Simulate carrier' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(row('o4')).getByRole('button', { name: 'Simulate carrier' }));
    await waitFor(() => expect(posted('o4/advance-shipment')).toHaveLength(1));

    fireEvent.click(within(row('o1')).getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel order' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(posted('o1/cancel')).toEqual([{ url: '/demo/shops/shop-1/orders/o1/cancel', method: 'POST', body: { reason: 'Out of stock' } }]));

    await waitFor(() => expect(within(row('o4')).getByRole('button', { name: 'Print label' }).hasAttribute('disabled')).toBe(false));
    fireEvent.change(within(row('o4')).getByRole('combobox', { name: 'Document type for o4' }), { target: { value: 'PACKING_SLIP' } });
    fireEvent.click(within(row('o4')).getByRole('button', { name: 'Print packing slip' }));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('http://localhost:8090/demo/files/shipping-documents/abc.pdf'));
    expect(tab.opener).toBeNull();
    expect(posted('o4/shipping-label')).toHaveLength(1);
    expect(posted('o4/shipping-label')[0].body).toEqual({ documentType: 'PACKING_SLIP' });
  });

  it('shows the order detail: progress, history, package, amounts and actions', async () => {
    renderAt('/seller-center/orders/o5');
    expect(await screen.findByRole('heading', { name: 'Order o5' })).toBeTruthy();
    const progress = screen.getByRole('region', { name: 'Order progress' });
    expect(within(progress).getByText('In transit').closest('li')?.getAttribute('aria-current')).toBe('step');

    const historyRows = within(screen.getByRole('region', { name: 'Status history' })).getAllByRole('row').slice(1);
    expect(historyRows).toHaveLength(4);
    expect(historyRows[1].textContent).toContain('Unpaid → Awaiting shipment');
    expect(historyRows[1].textContent).toContain('Buyer');
    expect(historyRows[1].textContent).toContain('fake payment');

    const pkg = screen.getByRole('region', { name: 'Package' });
    expect(await within(pkg).findByText('SIM-o5')).toBeTruthy();
    expect(within(pkg).getByText('pkg-o5')).toBeTruthy();
    expect(within(pkg).getByText('Simulator Express (fake carrier)')).toBeTruthy();

    expect(within(screen.getByRole('region', { name: 'Items' })).getByText('-₫25.800')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recipient' })).getByText('45 Trần Phú, Hà Đông, Hà Nội')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print label' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Simulate carrier' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Arrange shipment' })).toBeNull();
  });

  it('says when an order does not exist', async () => {
    renderAt('/seller-center/orders/nope');
    expect(await screen.findByText('Order not found.')).toBeTruthy();
  });
});
