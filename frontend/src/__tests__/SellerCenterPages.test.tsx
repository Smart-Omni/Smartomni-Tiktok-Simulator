import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession } from '@/lib/types';
import { SellerMessages } from '@/pages/seller-center/SellerMessages';
import { SellerProducts } from '@/pages/seller-center/SellerProducts';
import { SellerReturns } from '@/pages/seller-center/SellerReturns';
import { batchBody, batchCsv, batchValid, emptyBatch, emptyVoucher, SellerVouchers, voucherBody, voucherValid } from '@/pages/seller-center/SellerVouchers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 24 * 3600_000).toISOString();
const seller: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };
const base = '/demo/shops/shop-1';

const request = (id: string, status: string) => ({
  id,
  orderId: `ord-${id}`,
  kind: 'RETURN',
  type: 'REFUND',
  status,
  reason: 'DAMAGED_ITEM',
  role: 'BUYER',
  rejectReason: null,
  returnTrackingNumber: null,
  buyer: { id: 'b', name: 'Trần Văn An' },
  refund: { subtotalVnd: 129000, shippingVnd: 0, totalVnd: 129000 },
  createdAt: future,
  updatedAt: future,
  items: [{ skuId: 's', productName: 'Tee', skuName: 'M', quantity: 1 }],
});

const sku = (row: string, sellerSku: string, quantity: number) => ({
  id: row,
  externalId: `ext-${row}`,
  sellerSku,
  name: sellerSku.slice(-1),
  attributeName: 'Size',
  priceVnd: 129000,
  status: 'NORMAL',
  stock: [{ warehouseId: 'w1', warehouseName: 'Kho HN', quantity }],
  totalStock: quantity,
});
const catalog = {
  currency: 'VND',
  warehouses: [{ externalId: 'w1', name: 'Kho HN' }],
  items: [
    { id: 'row-p1', externalId: 'P1', title: 'Basic tee', description: '', status: 'ACTIVATE', isNotForSale: false, skus: [sku('row-s1', 'TEE-M', 3)] },
    { id: 'row-p2', externalId: 'P2', title: 'Mug', description: '', status: 'ACTIVATE', isNotForSale: false, skus: [sku('row-s2', 'MUG-B', 40)] },
  ],
};

const message = (id: string, role: string, text: string) => ({ id, index: 1, type: 'TEXT', role, roleLabel: role === 'BUYER' ? 'Buyer' : 'Shop', nickname: 'x', at: future, text, supported: true });
const conversation = (id: string, name: string, unread: number, canSendMessage = true) => ({
  id,
  externalId: `ext-${id}`,
  buyerNickname: name,
  agentJoined: false,
  canSendMessage,
  unread,
  latest: message(`${id}-m1`, 'BUYER', `Hello from ${name}`),
  updatedAt: future,
});

const batch = (id: string, title: string, status: string, redeemed: number, quantity: number) => ({
  id,
  title,
  status,
  discountType: 'PERCENT_OFF',
  amountOffVnd: null,
  percentage: 30,
  maxDiscountVnd: null,
  discountText: '30% off',
  minSpendVnd: null,
  audience: 'ALL',
  quantity,
  redeemed,
  startAt: future,
  endAt: future,
  createdAt: future,
});
const batchCodes = [
  { id: '7700000000000001', promoCode: 'K7M2QX9PRT', redeemedCount: 1, status: 'ONGOING' },
  { id: '7700000000000002', promoCode: 'HV4N8WZ3EA', redeemedCount: 0, status: 'DEACTIVATED' },
  { id: '7700000000000003', promoCode: 'ABCDEFGH23', redeemedCount: 0, status: 'ONGOING' },
];

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
      if (method === 'POST' && url === `${base}/coupon-batches`) return json({ batch: batch('b2', 'New batch', 'ONGOING', 0, 2), codes: batchCodes.slice(0, 2) }, 201);
      if (method !== 'GET') return json({}, method === 'DELETE' ? 200 : 201);
      if (url === '/test-admin/clock') return json({ now: '2040-01-01T00:00:00.000Z' });
      if (url === `${base}/coupon-batches`) return json({ items: [batch('b1', 'Loyalty Diamond 30%', 'ONGOING', 1, 3)] });
      const batchMatch = /\/coupon-batches\/(b\d)$/.exec(url);
      if (batchMatch) return json({ batch: batch(batchMatch[1], 'Loyalty Diamond 30%', 'ONGOING', 1, 3), codes: batchCodes });
      if (url === `${base}/aftersale`) {
        return json({
          items: [request('r1', 'RETURN_OR_REFUND_REQUEST_PENDING'), request('r2', 'BUYER_SHIPPED_ITEM'), request('r3', 'RETURN_OR_REFUND_REQUEST_COMPLETE')],
          requestReasons: [],
          rejectReasons: [
            { name: 'ITEM_AS_DESCRIBED', text: 'The item matches its description' },
            { name: 'OTHER', text: 'Other reason' },
          ],
        });
      }
      if (url === `${base}/catalog`) return json(catalog);
      if (url === `${base}/inventory/history`) return json({ changes: [], attempts: [] });
      if (url === `${base}/coupons`) {
        return json({ items: [{ id: 'c1', title: 'Ten off', promoCode: 'SALE10', status: 'ONGOING', discountType: 'PERCENT_OFF', amountOffVnd: null, percentage: 10, maxDiscountVnd: 30000, discountText: '10% off (max 30000 VND)', minSpendVnd: 100000, startAt: future, endAt: future, redemptionLimit: 100, redeemedCount: 3, audience: 'ALL' }] });
      }
      if (url === `${base}/chat/conversations`) {
        return json({ supportedTypes: ['TEXT'], unsupported: 'IMAGE, VIDEO', items: [conversation('c1', 'An', 2), conversation('c2', 'Mai', 0, false)] });
      }
      const thread = /\/chat\/conversations\/(c\d)\/messages$/.exec(url);
      if (thread) {
        const c = thread[1] === 'c1' ? conversation('c1', 'An', 2) : conversation('c2', 'Mai', 0, false);
        return json({ conversation: c, items: [message('m1', 'BUYER', `Hello from ${c.buyerNickname}`), message('m2', 'SHOP', 'Hi, how can we help?')] });
      }
      return json({ message: 'nope' }, 404);
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
          <Route path="/seller-center/returns" element={<SellerReturns />} />
          <Route path="/seller-center/products" element={<SellerProducts />} />
          <Route path="/seller-center/vouchers" element={<SellerVouchers />} />
          <Route path="/seller-center/messages" element={<SellerMessages />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
const writes = () => calls.filter((c) => c.method !== 'GET');
const requestRows = () => screen.getAllByRole('row').map((r) => r.getAttribute('aria-label')).filter(Boolean);

describe('Seller Center returns', () => {
  it('lists open requests and approves or rejects them with the legacy calls', async () => {
    renderAt('/seller-center/returns?status=open');
    expect(await screen.findByRole('tab', { name: 'Open (2)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All (3)' })).toBeTruthy();
    expect(requestRows()).toEqual(['Request r1', 'Request r2']);
    const r2 = screen.getByRole('row', { name: 'Request r2' });
    expect(within(r2).getByRole('button', { name: 'Accept package' })).toBeTruthy();

    fireEvent.click(within(screen.getByRole('row', { name: 'Request r1' })).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(writes()).toEqual([{ url: `${base}/aftersale/r1/approve`, method: 'POST', body: {} }]));

    fireEvent.change(within(r2).getByRole('combobox', { name: 'Reject reason for r2' }), { target: { value: 'OTHER' } });
    fireEvent.click(within(r2).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(writes()[1]).toEqual({ url: `${base}/aftersale/r2/reject`, method: 'POST', body: { reason: 'OTHER' } }));

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'All (3)' }));
    expect(requestRows()).toEqual(['Request r1', 'Request r2', 'Request r3']);
  });
});

describe('Seller Center products', () => {
  const card = (externalId: string) => screen.getByRole('region', { name: `Product ${externalId}` });

  it('combines search and status filters and restores results from the empty state', async () => {
    renderAt('/seller-center/products');
    await screen.findByRole('region', { name: 'Product P1' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search products' }), { target: { value: 'mug-b' } });
    expect(card('P2')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Product P1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Draft 0' }));
    expect(screen.getByRole('heading', { name: 'No matching products' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Product pagination' }).textContent).toContain('Showing 0–0');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(card('P1')).toBeTruthy();
    expect(card('P2')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort products' }), { target: { value: 'stock' } });
    expect(screen.getAllByRole('region', { name: /^Product P/ }).map((el) => el.getAttribute('aria-label'))).toEqual(['Product P1', 'Product P2']);
    expect(writes()).toHaveLength(0);
  });

  it('paginates the catalog and keeps product editors collapsed until requested', async () => {
    const fetchCatalog = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url === `${base}/catalog`
      ? Promise.resolve(json({ ...catalog, items: Array.from({ length: 11 }, (_, i) => ({ ...catalog.items[0], id: `p-${i}`, externalId: `P${i + 1}` })) }))
      : fetchCatalog(url, init)));
    renderAt('/seller-center/products');
    await screen.findByRole('region', { name: 'Product P1' });
    expect(screen.getAllByRole('region', { name: /^Product P/ })).toHaveLength(10);
    expect(screen.queryByRole('region', { name: 'Product P11' })).toBeNull();
    fireEvent.click(within(card('P1')).getByRole('button', { name: 'Manage' }));
    expect(within(card('P1')).getByRole('row', { name: 'SKU TEE-M' })).toBeTruthy();
    fireEvent.click(within(card('P1')).getByRole('button', { name: 'Collapse' }));
    expect(within(card('P1')).queryByRole('row', { name: 'SKU TEE-M' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next product page' }));
    expect(screen.getAllByRole('region', { name: /^Product P/ })).toHaveLength(1);
    expect(card('P11')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next product page' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous product page' }));
    expect(card('P1')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('edits price, stock and status of a SKU and adds a variant', async () => {
    renderAt('/seller-center/products');
    const product = await screen.findByRole('region', { name: 'Product P1' });
    expect(within(product).queryByRole('row', { name: 'SKU TEE-M' })).toBeNull();
    fireEvent.click(within(product).getByRole('button', { name: 'Manage' }));
    const row = within(product).getByRole('row', { name: 'SKU TEE-M' });
    const [setPrice, setStock] = within(row).getAllByRole('button', { name: 'Set' });

    fireEvent.change(within(row).getByLabelText('Price of TEE-M'), { target: { value: '135000' } });
    fireEvent.click(setPrice);
    await waitFor(() => expect(writes()).toContainEqual({ url: `${base}/catalog/skus/row-s1`, method: 'PATCH', body: { priceVnd: 135000 } }));

    fireEvent.change(within(row).getByLabelText('Stock of TEE-M in Kho HN'), { target: { value: '7' } });
    fireEvent.click(setStock);
    await waitFor(() => expect(writes()).toContainEqual({ url: `${base}/catalog/skus/row-s1`, method: 'PATCH', body: { stock: { w1: 7 } } }));

    fireEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(writes()).toContainEqual({ url: `${base}/catalog/skus/row-s1`, method: 'PATCH', body: { status: 'DEACTIVATED' } }));

    const add = within(card('P1')).getByRole('form', { name: 'Add variant to P1' });
    fireEvent.change(within(add).getByLabelText('New seller SKU'), { target: { value: 'TEE-L' } });
    fireEvent.change(within(add).getByLabelText('New variant name'), { target: { value: 'L' } });
    fireEvent.change(within(add).getByLabelText('New variant price'), { target: { value: '139000' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Add variant' }));
    await waitFor(() => expect(writes()).toContainEqual({ url: `${base}/catalog/products/row-p1/skus`, method: 'POST', body: { sellerSku: 'TEE-L', name: 'L', priceVnd: 139000 } }));
  });

  it('links to the product page for new products and details, and deletes one only after confirming', async () => {
    renderAt('/seller-center/products');
    await screen.findByRole('region', { name: 'Product P1' });
    expect(screen.getByRole('link', { name: 'New product' }).getAttribute('href')).toBe('/seller-center/products/new');
    fireEvent.click(within(card('P1')).getByRole('button', { name: 'Manage' }));
    expect(within(card('P1')).getByRole('link', { name: 'Edit details' }).getAttribute('href')).toBe('/seller-center/products/row-p1/edit');
    expect(within(card('P1')).getByLabelText('No image')).toBeTruthy();

    fireEvent.click(within(card('P2')).getByRole('button', { name: 'Manage' }));
    fireEvent.click(within(card('P2')).getByRole('button', { name: 'Delete' }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete product?' })).getByRole('button', { name: 'Delete product' }));
    await waitFor(() => expect(writes()[0]).toEqual({ url: `${base}/catalog/products/row-p2`, method: 'DELETE', body: undefined }));
  });

  it('shows only low-stock products with ?filter=low-stock', async () => {
    renderAt('/seller-center/products?filter=low-stock');
    expect(await screen.findByRole('region', { name: 'Product P1' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Product P2' })).toBeNull();
  });
});

describe('Seller Center vouchers', () => {
  it('rejects values beyond API limits and accepts the inclusive boundaries', () => {
    const f = { ...emptyVoucher, title: 'x'.repeat(100), value: '2000000000', minSpend: '2000000000', limit: '1000000' };
    expect(voucherValid(f)).toBe(true);
    for (const invalid of [{ title: 'x'.repeat(101) }, { value: '2000000001' }, { minSpend: '2000000001' }, { limit: '1000001' }, { days: '1e9' }]) {
      expect(voucherValid({ ...f, ...invalid })).toBe(false);
    }
    expect(voucherValid({ ...f, kind: 'PERCENT_OFF', value: '100', cap: '2000000000' })).toBe(true);
    expect(voucherValid({ ...f, kind: 'PERCENT_OFF', value: '100', cap: '2000000001' })).toBe(false);
    expect(batchValid({ ...emptyBatch, title: 'Batch', value: '30', quantity: '500' })).toBe(true);
    expect(batchValid({ ...emptyBatch, title: 'Batch', value: '30', minSpend: '2000000001' })).toBe(false);
    expect(() => batchBody({ ...emptyBatch, title: 'Batch', value: '30' }, NaN)).toThrow('business clock');
  });

  it('validates and builds the coupon body like the legacy form', () => {
    const f = { ...emptyVoucher, title: 'Ten off', promoCode: 'SALE2026', kind: 'PERCENT_OFF', value: '10', cap: '30000', days: '7' };
    expect(voucherValid(f)).toBe(true);
    expect(voucherValid({ ...f, promoCode: 'SALE' })).toBe(false);
    expect(voucherValid({ ...f, value: '101' })).toBe(false);
    expect(voucherBody(f, Date.UTC(2026, 9, 21))).toEqual({
      title: 'Ten off',
      promoCode: 'SALE2026',
      discount: { type: 'PERCENT_OFF', percentage: 10, maxDiscountVnd: 30000 },
      endAt: '2026-10-28T00:00:00.000Z',
      audience: 'ALL',
    });
  });

  it('deactivates and creates vouchers', async () => {
    renderAt('/seller-center/vouchers');
    const row = await screen.findByRole('row', { name: 'Voucher SALE10' });
    fireEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(writes()).toEqual([{ url: `${base}/coupons/c1`, method: 'PATCH', body: { deactivated: true } }]));

    fireEvent.click(screen.getByRole('button', { name: 'New voucher' }));
    const dialog = await screen.findByRole('dialog', { name: 'New voucher' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Welcome' } });
    fireEvent.change(within(dialog).getByLabelText('Code'), { target: { value: 'hello2026' } });
    fireEvent.change(within(dialog).getByLabelText('Amount off (VND)'), { target: { value: '20000' } });
    fireEvent.change(within(dialog).getByLabelText('Audience'), { target: { value: 'NEW' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create voucher' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ url: `${base}/coupons`, method: 'POST', body: { title: 'Welcome', promoCode: 'HELLO2026', discount: { type: 'AMOUNT_OFF', amountVnd: 20000 }, audience: 'NEW', endAt: '2040-01-08T00:00:00.000Z' } });
  });

  it('accepts an empty voucher code (generated by the backend) but still rejects a malformed one', () => {
    const f = { ...emptyVoucher, title: 'Auto code', value: '20000' };
    expect(voucherValid(f)).toBe(true);
    expect(voucherBody(f, Date.UTC(2026, 9, 21))).not.toHaveProperty('promoCode');
    expect(voucherValid({ ...f, promoCode: 'BAD-1' })).toBe(false);
    expect(voucherValid({ ...f, promoCode: 'ABC12' })).toBe(false);
  });

  it('validates and builds the batch body without promoCode or redemptionLimit', () => {
    const f = { ...emptyBatch, title: 'Loyalty Diamond 30%', value: '30', quantity: '100', days: '30' };
    expect(batchValid(f)).toBe(true);
    expect(batchValid({ ...f, quantity: '0' })).toBe(false);
    expect(batchValid({ ...f, quantity: '501' })).toBe(false);
    expect(batchValid({ ...f, value: '101' })).toBe(false);
    expect(batchBody(f, Date.UTC(2026, 10, 20))).toEqual({ title: 'Loyalty Diamond 30%', discount: { type: 'PERCENT_OFF', percentage: 30 }, endAt: '2026-12-20T00:00:00.000Z', audience: 'ALL', quantity: 100 });
  });

  it('builds the codes CSV with the promo_code,coupon_id,redeemed_count,status columns', () => {
    expect(batchCsv(batchCodes)).toBe('promo_code,coupon_id,redeemed_count,status\nK7M2QX9PRT,7700000000000001,1,ONGOING\nHV4N8WZ3EA,7700000000000002,0,DEACTIVATED\nABCDEFGH23,7700000000000003,0,ONGOING\n');
  });

  it('shows code batches with Used counts, deactivates a batch and lists its codes', async () => {
    renderAt('/seller-center/vouchers?tab=batches');
    expect(screen.getByRole('tab', { name: 'Code batches' }).getAttribute('data-state')).toBe('active');
    const row = await screen.findByRole('row', { name: 'Batch Loyalty Diamond 30%' });
    expect(within(row).getByText('1 / 3')).toBeTruthy();
    expect(within(row).getByText('30% off')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(writes()).toEqual([{ url: `${base}/coupon-batches/b1`, method: 'PATCH', body: { deactivated: true } }]));

    fireEvent.click(within(row).getByRole('button', { name: 'View codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Codes of Loyalty Diamond 30%' });
    const codes = await within(dialog).findAllByRole('row', { name: /^Code [A-Z0-9]{10}$/ });
    expect(codes.map((r) => r.getAttribute('aria-label'))).toEqual(['Code K7M2QX9PRT', 'Code HV4N8WZ3EA', 'Code ABCDEFGH23']);
    expect(within(codes[1]).getByText('Deactivated')).toBeTruthy();

    const writeText = vi.fn(async (text: string) => void text);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy all' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('K7M2QX9PRT\nHV4N8WZ3EA\nABCDEFGH23'));

    const createObjectURL = vi.fn((blob: Blob) => (blob ? 'blob:codes' : ''));
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download CSV' }));
    expect(click).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0];
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(csv).toBe(batchCsv(batchCodes));
    click.mockRestore();
  });

  it('creates a code batch with the right body and opens its codes', async () => {
    renderAt('/seller-center/vouchers?tab=batches');
    await screen.findByRole('row', { name: 'Batch Loyalty Diamond 30%' });
    fireEvent.click(screen.getByRole('button', { name: 'New code batch' }));
    const dialog = await screen.findByRole('dialog', { name: 'New code batch' });
    expect(within(dialog).queryByLabelText('Code')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'New batch' } });
    fireEvent.change(within(dialog).getByLabelText('Percent off (1-100)'), { target: { value: '30' } });
    fireEvent.change(within(dialog).getByLabelText('Quantity (1-500)'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [w] = writes();
    expect(w).toMatchObject({ url: `${base}/coupon-batches`, method: 'POST', body: { title: 'New batch', discount: { type: 'PERCENT_OFF', percentage: 30 }, quantity: 2, audience: 'ALL', endAt: '2040-01-31T00:00:00.000Z' } });
    expect(w.body).not.toHaveProperty('promoCode');
    expect(w.body).not.toHaveProperty('redemptionLimit');
    expect(await screen.findByRole('dialog', { name: /^Codes of / })).toBeTruthy();
  });
});

describe('Seller Center messages', () => {
  it('filters unread conversations, opens one and sends a text', async () => {
    renderAt('/seller-center/messages?filter=unread');
    const list = await screen.findByRole('list', { name: 'Conversations' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['AAnHello from An2 unread']);

    fireEvent.click(within(list).getByRole('button'));
    const thread = screen.getByRole('region', { name: 'Chat thread' });
    expect(await within(thread).findByText('Hi, how can we help?')).toBeTruthy();
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: 'Size L is back' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes()).toEqual([{ url: `${base}/chat/conversations/c1/messages`, method: 'POST', body: { text: 'Size L is back' } }]));
  });

  it('locks the reply box when the shop cannot send messages', async () => {
    renderAt('/seller-center/messages');
    fireEvent.click(within(await screen.findByRole('list', { name: 'Conversations' })).getByRole('button', { name: /Mai/ }));
    const thread = screen.getByRole('region', { name: 'Chat thread' });
    expect(await within(thread).findByText(/can_send_message = false/)).toBeTruthy();
    expect((within(thread).getByRole('textbox', { name: 'Message' }) as HTMLInputElement).disabled).toBe(true);
  });
});
