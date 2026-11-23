import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxPanel } from '../pages/console/SandboxPanel';
import { ArbitrationPanel } from '../pages/console/ArbitrationPanel';
import { OrderAuditPanel } from '../pages/console/OrderAuditPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const catalog = {
  shop_id: 'external-shop',
  products: [{ product_id: 'product-1', title: 'Test shirt', sku_list: [{ id: 'sku-1', seller_sku: 'SHIRT-M', price: 100000, stock_count: 3 }] }],
  limits: { max_quantity_per_sku: 20, max_order_count: 10 },
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Admin sandbox', () => {
  it('keeps SKU selections across pages and submits them together', async () => {
    const pagedCatalog = { ...catalog, products: [{ ...catalog.products[0], sku_list: Array.from({ length: 12 }, (_, i) => ({ ...catalog.products[0].sku_list[0], id: `sku-${i + 1}`, seller_sku: `SKU-${i + 1}` })) }] };
    const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async (url) => url.startsWith('/test-admin/sandbox/products') ? json(pagedCatalog) : json({ created: [], failed: [], request_id: 'request-1' }));
    vi.stubGlobal('fetch', fetcher);
    render(<SandboxPanel shopId="shop-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Select SKU-1$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select SKU-11' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect((screen.getByRole('checkbox', { name: /^Select SKU-1$/ }) as HTMLInputElement).checked).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create test orders' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/test-admin/sandbox/orders')).toBe(true));
    const request = fetcher.mock.calls.find(([url]) => url === '/test-admin/sandbox/orders')!;
    expect(JSON.parse(request[1]!.body as string).items).toEqual([
      { product_id: 'product-1', sku_id: 'sku-1', quantity: 1 },
      { product_id: 'product-1', sku_id: 'sku-11', quantity: 1 },
    ]);
  });

  it('blocks a batch whose combined quantity exceeds stock', async () => {
    const fetcher = vi.fn(async () => json(catalog));
    vi.stubGlobal('fetch', fetcher);
    render(<SandboxPanel shopId="shop-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select SHIRT-M' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of orders' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity of SHIRT-M' }), { target: { value: '2' } });
    expect(screen.getByText('Insufficient stock for this batch')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create test orders' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it('submits the selected shop and SKU and preserves partial batch results without retrying failed orders', async () => {
    const fetcher = vi.fn(async (url: string) => url.startsWith('/test-admin/sandbox/products') ? json(catalog) : json({ created: [{ order_id: 'order-1', status: 'UNPAID' }], failed: [{ index: 1, error: 'insufficient_stock' }], request_id: 'request-1' }));
    vi.stubGlobal('fetch', fetcher);
    render(<SandboxPanel shopId="shop-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select SHIRT-M' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of orders' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Simulate payment after checkout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create test orders' }));
    const result = await screen.findByRole('region', { name: 'Batch result' });
    expect(within(result).getByText('order-1')).toBeTruthy();
    expect(within(result).getByText('Order 2: insufficient_stock')).toBeTruthy();
    const posts = fetcher.mock.calls.filter(([url]) => url === '/test-admin/sandbox/orders');
    expect(posts).toHaveLength(1);
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url === '/test-admin/sandbox/orders')![1];
    expect(JSON.parse(options.body as string)).toEqual({ shopId: 'shop-1', items: [{ product_id: 'product-1', sku_id: 'sku-1', quantity: 1 }], order_count: 2, pay: false });
  });

  it('does not automatically retry when a create response is lost', async () => {
    const fetcher = vi.fn(async (url: string) => { if (url.startsWith('/test-admin/sandbox/products')) return json(catalog); throw new Error('Network lost'); });
    vi.stubGlobal('fetch', fetcher);
    render(<SandboxPanel shopId="shop-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select SHIRT-M' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create test orders' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Check Orders before creating another batch');
    expect(fetcher.mock.calls.filter(([url]) => url === '/test-admin/sandbox/orders')).toHaveLength(1);
  });
});

describe('Admin arbitration and order history', () => {
  it('sends an explicit arbitration decision with the selected shop and shows backend rejection', async () => {
    const fetcher = vi.fn(async () => json({ message: 'invalid arbitration transition' }, 400));
    vi.stubGlobal('fetch', fetcher);
    render(<ArbitrationPanel shopId="shop-2" initialRef="return/1" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Target arbitration status' }), { target: { value: 'ARBITRATION_WIN' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Operator note/ }), { target: { value: 'Reviewed evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply arbitration decision' }));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid arbitration transition');
    const [url, options] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('/test-admin/aftersale/return%2F1/arbitration');
    expect(JSON.parse(options.body as string)).toEqual({ shopId: 'shop-2', arbitration_status: 'ARBITRATION_WIN', note: 'Reviewed evidence' });
  });

  // the history is legacy data written before ON_HOLD was removed: the panel shows raw statuses (DECISIONS H12)
  it('loads audit for an encoded order reference and the selected shop', async () => {
    const fetcher = vi.fn(async () => json({ orderId: 'order/1', status: 'ON_HOLD', history: [{ from: 'UNPAID', to: 'ON_HOLD', actor: 'BUYER', note: 'Paid', at: '2026-11-20T12:00:00Z' }] }));
    vi.stubGlobal('fetch', fetcher);
    const close = vi.fn();
    render(<OrderAuditPanel shopId="shop 2" orderRef="order/1" onClose={close} />);
    expect(await screen.findByText('UNPAID → ON_HOLD')).toBeTruthy();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/test-admin/orders/order%2F1/audit?shopId=shop%202', expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    expect(close).toHaveBeenCalledOnce();
  });
});
