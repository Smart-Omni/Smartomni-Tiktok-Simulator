import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerLayout } from '@/layouts/SellerLayout';
import { AuthProvider } from '@/lib/auth';
import type { Aftersale, Conversation, DemoSession, Order, OrderStatus } from '@/lib/types';
import { countByTab } from '@/lib/sellerOrders';
import { greeting, SellerHome, sellerTodo } from '@/pages/seller-center/SellerHome';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 24 * 3600_000).toISOString();
const seller: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };

const order = (id: string, status: OrderStatus, hour: number): Order => ({
  id,
  status,
  createdAt: `2026-10-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
  updatedAt: `2026-10-21T${String(hour).padStart(2, '0')}:00:00.000Z`,
  paidAt: null,
  cancelReason: null,
  buyerRequestedCancel: false,
  recipient: { name: 'An', phone: '0900000001', addressLine: 'x', district: 'y', city: 'z' },
  buyer: { id: 'b1', name: `Buyer ${id}` },
  amounts: { currency: 'VND', productTotalVnd: 100000, sellerDiscountVnd: 0, platformDiscountVnd: 0, subTotalVnd: 100000, shippingFeeVnd: 25000, taxVnd: 0, totalVnd: 125000 },
  items: [{ skuId: 's', productId: 'p', productName: 'Tee', skuName: 'M', sellerSku: 'T', unitPriceVnd: 100000, quantity: 1 }],
});
const orders = [
  order('o1', 'UNPAID', 1),
  order('o2', 'UNPAID', 2),
  order('o3', 'AWAITING_SHIPMENT', 3),
  order('o4', 'AWAITING_COLLECTION', 4),
  order('o5', 'IN_TRANSIT', 5),
  order('o6', 'DELIVERED', 6),
  order('o7', 'CANCELLED', 7),
  order('o0', 'AWAITING_SHIPMENT', 0),
];
const request = (status: string) => ({ status }) as Aftersale;
const aftersale = [request('RETURN_OR_REFUND_REQUEST_PENDING'), request('BUYER_SHIPPED_ITEM'), request('RETURN_OR_REFUND_REQUEST_COMPLETE')];
const chat = (unread: number) => ({ unread }) as Conversation;
const conversations = [chat(1), chat(3), chat(0)];

describe('sellerTodo', () => {
  it('counts the to-do items from orders, open aftersale requests and unread messages', () => {
    expect(sellerTodo(orders, aftersale, conversations)).toEqual({ toPay: 2, toShip: 3, inTransit: 1, returns: 2, unread: 4 });
    expect(sellerTodo(undefined, undefined, undefined)).toEqual({ toPay: null, toShip: null, inTransit: null, returns: null, unread: null });
  });

  it('counts To ship exactly like the Manage orders tab', () => {
    expect(sellerTodo(orders).toShip).toBe(countByTab(orders)['to-ship']);
    expect(countByTab(orders)).toEqual({ all: 8, unpaid: 2, 'to-ship': 3, shipped: 1, completed: 1, cancelled: 1 });
  });

  it('greets by the time of day', () => {
    expect(greeting(new Date(2026, 9, 21, 9))).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 21, 14))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 21, 20))).toBe('Good evening');
  });
});

describe('SellerHome', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 14, 30));
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(seller));
    const base = '/demo/shops/shop-1';
    const routes: Record<string, unknown> = {
      '/demo/identities': { sellers: [{ id: 'seller_1', name: 'Nguyễn Thị Lan', shops: [{ id: 'shop-1', name: 'Mộc Lan' }] }], buyers: [] },
      [`${base}/orders`]: { items: orders },
      [`${base}/aftersale`]: { items: aftersale, requestReasons: [], rejectReasons: [] },
      [`${base}/chat/conversations`]: { items: conversations },
      [base]: { id: 'shop-1', name: 'Mộc Lan', region: 'VN', currency: 'VND', status: 'ACTIVE', warehouses: [] },
      [`${base}/catalog`]: {
        currency: 'VND',
        items: [
          { id: 'p1', skus: [{ status: 'NORMAL', totalStock: 3 }, { status: 'NORMAL', totalStock: 40 }] },
          { id: 'p2', skus: [{ status: 'DEACTIVATED', totalStock: 2 }] },
        ],
      },
      [`${base}/coupons`]: { items: [{ status: 'ONGOING' }, { status: 'ONGOING' }, { status: 'EXPIRED' }] },
      [`${base}/coupon-batches`]: { items: [{ status: 'ONGOING' }, { status: 'DEACTIVATED' }] },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url in routes ? json(routes[url]) : json({ message: 'nope' }, 404))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const renderHome = () =>
    render(
      <MemoryRouter initialEntries={['/seller-center']}>
        <AuthProvider>
          <Routes>
            <Route path="/seller-center" element={<SellerLayout />}>
              <Route index element={<SellerHome />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

  it('shows the working shop in the sidebar and links each to-do count to its filtered page', async () => {
    renderHome();
    expect(await within(screen.getByRole('complementary')).findByText('Nguyễn Thị Lan')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const todo = screen.getByRole('region', { name: 'To-do list' });
    const expected: [string, string, string][] = [
      ['2To pay', '/seller-center/orders?tab=unpaid', 'To pay'],
      ['3To ship', '/seller-center/orders?tab=to-ship', 'To ship'],
      ['1In transit', '/seller-center/orders?tab=shipped', 'In transit'],
      ['2Returns', '/seller-center/returns?status=open', 'Returns'],
      ['4Unread messages', '/seller-center/messages?filter=unread', 'Unread messages'],
    ];
    for (const [text, href, name] of expected) {
      const link = await within(todo).findByRole('link', { name: new RegExp(`${name}$`) });
      await vi.waitFor(() => expect(link.textContent).toBe(text));
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('shows the shop card from shop, catalog and coupons', async () => {
    renderHome();
    const card = await screen.findByRole('region', { name: 'Shop' });
    expect(await within(card).findByText('Mộc Lan')).toBeTruthy();
    expect(within(card).getByText('Region VN')).toBeTruthy();
    expect(within(card).getByText('Active')).toBeTruthy();
    await vi.waitFor(() => expect(within(card).getByRole('link', { name: /Products$/ }).textContent).toBe('2Products'));
    await vi.waitFor(() => expect(within(card).getByRole('link', { name: /Active vouchers$/ }).textContent).toBe('2Active vouchers'));
    await vi.waitFor(() => expect(within(card).getByRole('link', { name: /Low stock/ }).textContent).toBe('1Low stock (≤5)'));
    // single vouchers and code batches are counted apart
    await vi.waitFor(() => expect(within(card).getByRole('link', { name: /Code batches/ }).textContent).toBe('Code batches: 1 active'));
    expect(within(card).getByRole('link', { name: /Code batches/ }).getAttribute('href')).toBe('/seller-center/vouchers?tab=batches');
  });

  it('lists the 5 latest orders and derives Business overview from API orders', async () => {
    renderHome();
    const latest = await screen.findByRole('region', { name: 'Latest orders' });
    await vi.waitFor(() => expect(within(latest).getAllByRole('listitem')).toHaveLength(5));
    const ids = within(latest).getAllByRole('listitem').map((li) => li.querySelector('.font-mono')?.textContent);
    expect(ids).toEqual(['o7', 'o6', 'o5', 'o4', 'o3']);
    expect(within(latest).getAllByRole('link')[1].getAttribute('href')).toBe('/seller-center/orders/o7');
    expect(within(latest).getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/seller-center/orders');

    const overview = screen.getByRole('region', { name: 'Business overview' });
    expect(overview.closest('[data-mock]')).toBeNull();
    expect(within(overview).getByText('Total orders')).toBeTruthy();
    expect(within(overview).getByText('8')).toBeTruthy();
    expect(within(overview).getByText('All shop orders')).toBeTruthy();
  });
});
