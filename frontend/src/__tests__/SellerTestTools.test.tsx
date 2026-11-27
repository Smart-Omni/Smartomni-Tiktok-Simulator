import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AftersaleTestActions } from '@/components/seller/AftersaleTestActions';
import { ForceStatusMenu } from '@/components/seller/ForceStatusMenu';
import { TestToolsButton, TestToolsFrame } from '@/components/seller/TestTools';
import { LoyaltyOrdersForm } from '@/pages/console/LoyaltyOrdersForm';
import { BulkProductsForm } from '@/pages/console/ShopsPanel';
import { AuthProvider } from '@/lib/auth';
import { SellerTestingSystem } from '@/pages/seller-center/SellerTesting';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Seller Center test tools', () => {
  it('renders console panels inside the legacy .app/.admin-console/.admin-panel frame', () => {
    render(<TestToolsFrame><button>Panel action</button></TestToolsFrame>);
    const button = screen.getByRole('button', { name: 'Panel action' });
    expect(button.closest('.app.seller-test-tools')).toBeTruthy();
    expect(button.closest('.admin-console')).toBeTruthy();
    expect(button.closest('.admin-panel')).toBeTruthy();
  });

  it('shows simulator status, seed and the business clock on the System page, without reset', async () => {
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify({ sessionToken: 'tok', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const clock = { now: '2026-11-27T12:00:00.000Z', systemNow: '2026-11-27T12:00:00.000Z', offsetMs: 0, frozen: false };
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/test-admin/status') return json({ service: 'sim', database: { status: 'up', name: 'simulator' }, worker: { enabled: true, running: true, workerId: 'w', lastTickAt: null, lastError: null }, webhookJobs: {}, clock, seed: { shops: 1 }, publicApiBaseUrl: 'x', hostCallbackBaseUrl: 'y' });
      if (url === '/test-admin/clock') return json(clock);
      return json({});
    }));
    render(<MemoryRouter initialEntries={['/seller-center/testing/system']}><AuthProvider><Routes><Route path="/seller-center/testing/system" element={<SellerTestingSystem />} /></Routes></AuthProvider></MemoryRouter>);
    expect(await screen.findByText('Database')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('every shop');
    fireEvent.click(screen.getByRole('button', { name: 'Run seed (idempotent)' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/test-admin/seed', method: 'POST' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Business clock' }), { button: 0 });
    await waitFor(() => expect(calls.some((c) => c.url === '/test-admin/clock')).toBe(true));
    expect(screen.queryByText(/reset data/i)).toBeNull();
    expect(calls.some((c) => c.url.includes('/reset'))).toBe(false);
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('forces an order status through /test-admin, or one step when no status is chosen', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/test-admin/orders/ord-1/transition');
      bodies.push(JSON.parse(init!.body as string));
      return json({ id: 'ord-1', from: 'DELIVERED', status: 'COMPLETED', transitioned: true, updatedAt: 'x' });
    }));
    const onChanged = vi.fn();
    render(<ForceStatusMenu shopId="shop-1" orderId="ord-1" status="DELIVERED" onChanged={onChanged} />);
    const open = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Force status of ord-1' }), { key: 'Enter' });
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Completed' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Next step' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(bodies).toEqual([{ to: 'COMPLETED', shopId: 'shop-1' }, { shopId: 'shop-1' }]);
    vi.unstubAllGlobals();
  });

  it('hides Force status for a final order', () => {
    render(<ForceStatusMenu shopId="shop-1" orderId="ord-1" status="COMPLETED" onChanged={() => undefined} />);
    expect(screen.queryByRole('button', { name: /Force status/ })).toBeNull();
  });

  it('lists each loyalty test order with its case, completion time and sub total', async () => {
    const amounts = { productTotal: 230000, sellerDiscount: 0, platformDiscount: 0, subTotal: 230000, shippingFee: 25000, tax: 0, total: 255000 };
    vi.stubGlobal('fetch', vi.fn(async () => json({
      shopId: 'shop-1', thresholdDays: 15, note: 'Points come from sub_total.',
      orders: [
        { label: 'completed exactly 15 days ago (boundary)', orderId: 'o-1', status: 'COMPLETED', completedAt: '2026-11-12T12:00:00.000Z', deliveredAt: null, updatedAt: 'x', amountsVnd: amounts },
        { label: 'paid, awaiting shipment (never eligible)', orderId: 'o-2', status: 'AWAITING_SHIPMENT', completedAt: null, deliveredAt: null, updatedAt: 'x', amountsVnd: amounts },
      ],
    })));
    render(<LoyaltyOrdersForm shopId="shop-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate loyalty orders' }));
    const table = await screen.findByRole('region', { name: 'Loyalty test orders' });
    expect(within(table).getByText('Points come from sub_total.')).toBeTruthy();
    const boundary = within(table).getByText('completed exactly 15 days ago (boundary)').closest('tr')!;
    expect(within(boundary).getByText('230,000 VND')).toBeTruthy();
    expect(within(boundary).getByText('255,000 VND')).toBeTruthy();
    expect(within(within(table).getByText('o-2').closest('tr')!).getAllByText('—')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('completes a refund after confirming and shows the records of a request', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/records')) return json({ records: [{ from: null, to: 'RETURN_OR_REFUND_REQUEST_PENDING', actor: 'BUYER', note: 'requested', at: '2026-11-20T00:00:00.000Z' }] });
      return json({});
    }));
    const onChanged = vi.fn();
    render(<AftersaleTestActions shopId="shop-1" request={{ id: 'ret 1', kind: 'RETURN', status: 'RETURN_OR_REFUND_REQUEST_SUCCESS' }} onChanged={onChanged} />);
    const open = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Test actions for ret 1' }), { key: 'Enter' });
    open();
    expect(await screen.findByRole('menuitem', { name: 'Arbitrate dispute' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete refund' }));
    expect(calls).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Complete refund?' })).getByRole('button', { name: 'Complete refund' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/test-admin/aftersale/ret%201/complete?shopId=shop-1', method: 'POST' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View records' }));
    expect(await screen.findByText('Created → RETURN_OR_REFUND_REQUEST_PENDING')).toBeTruthy();
    expect(calls).toContainEqual({ url: '/test-admin/aftersale/ret%201/records?shopId=shop-1', method: 'GET' });
    vi.unstubAllGlobals();
  });

  it('offers no arbitration or completion when they do not apply', async () => {
    render(<AftersaleTestActions shopId="shop-1" request={{ id: 'c-1', kind: 'CANCELLATION', status: 'CANCELLATION_REQUEST_PENDING' }} onChanged={() => undefined} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Test actions for c-1' }), { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'View records' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Arbitrate dispute' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Complete refund' })).toBeNull();
  });

  it('generates bulk test products for the working shop within the API limits', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/test-admin/catalog/bulk');
      posts.push(JSON.parse(init!.body as string));
      return json({ created: 12, totalProducts: 40 });
    }));
    const onCreated = vi.fn();
    render(<BulkProductsForm shopId="shop-1" shopName="this shop" onCreated={onCreated} />);
    const count = screen.getByRole('spinbutton', { name: 'Products to create' });
    const submit = () => screen.getByRole('button', { name: /test products/ });
    fireEvent.change(count, { target: { value: '501' } });
    expect(submit().hasAttribute('disabled')).toBe(true);
    fireEvent.change(count, { target: { value: '12' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'SKUs per product' }), { target: { value: '3' } });
    fireEvent.click(submit());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('Added 12 products to this shop (40 in this shop).'));
    expect(posts).toEqual([{ shopId: 'shop-1', count: 12, skusPerProduct: 3 }]);
    vi.unstubAllGlobals();
  });

  it('opens a TEST sheet with one tab per tool, mounts only the active tab and reports the close', () => {
    const onClose = vi.fn();
    render(
      <TestToolsButton
        title="Order test tools"
        description="Create and move test orders."
        onClose={onClose}
        tabs={[
          { label: 'Create test orders', scope: 'shop', render: () => <p>sandbox panel</p> },
          { label: 'Clock', scope: 'all', render: () => <p>clock panel</p> },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test tools' }));
    const sheet = screen.getByRole('dialog', { name: /Order test tools/ });
    expect(within(sheet).getByText('TEST')).toBeTruthy();
    expect(within(sheet).getByText('sandbox panel')).toBeTruthy();
    expect(within(sheet).getByText('This shop only')).toBeTruthy();
    expect(within(sheet).queryByText('clock panel')).toBeNull();

    fireEvent.mouseDown(within(sheet).getByRole('tab', { name: 'Clock' }), { button: 0 });
    expect(within(sheet).getByText('clock panel')).toBeTruthy();
    expect(within(sheet).getByText('All shops')).toBeTruthy();
    expect(within(sheet).queryByText('sandbox panel')).toBeNull();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
