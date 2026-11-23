import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DisputesPanel } from '../pages/console/DisputesPanel';
import { listDisputes } from '../pages/console/disputeEndpoints';

const record = { disputeId: 'dispute/1', orderId: 'order-1', shopId: 'shop-1', status: 'DISPUTE_PENDING_REVIEW', createdAt: '2026-11-21T12:00:00Z', updatedAt: '2026-11-21T12:00:00Z' };
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', data }), { headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('scopes disputes to the working shop and fetches detail using an encoded ID', async () => {
  const fetcher = vi.fn(async (url: string) => json(url.endsWith('dispute%2F1') ? record : { disputes: [record, { ...record, disputeId: 'other-shop', shopId: 'shop-2' }] }));
  vi.stubGlobal('fetch', fetcher);
  render(<DisputesPanel shopId="shop-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'View dispute dispute/1' }));
  const detail = await screen.findByRole('region', { name: 'Dispute detail' });
  expect(await within(detail).findByText('order-1')).toBeTruthy();
  expect(screen.queryByText('other-shop')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith('/api/v2/simulator/dispute/dispute%2F1', expect.anything());
});

it('requires an explicit compensation amount and sends the selected shop with the approved event', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => json(options?.method === 'POST' ? { dispute_id: 'created-1', dispute_status: 'DISPUTE_APPROVED', webhook_enqueued: true, webhook_sent: false } : { disputes: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<DisputesPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'New dispute' }));
  const form = screen.getByRole('form', { name: 'Create dispute' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'Order ID' }), { target: { value: 'real-order' } });
  fireEvent.change(within(form).getByRole('combobox', { name: 'Status' }), { target: { value: 'DISPUTE_APPROVED' } });
  const submit = within(form).getByRole('button', { name: 'Create dispute' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Compensation amount' }), { target: { value: '125000' } });
  fireEvent.click(submit);
  await screen.findByText('created-1 · Approved');
  expect(screen.getByText(/Webhook queued: Yes · Direct delivery: Not sent/)).toBeTruthy();
  const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/v2/simulator/dispute/trigger');
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ shop_id: 'shop-1', order_id: 'real-order', status: 'DISPUTE_APPROVED', compensation_amount: 125000, currency: 'VND' });
});

it('preserves identifiers when updating and prevents transitions after the dispute ends', async () => {
  let current = { ...record, returnId: 'return-1' };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      current = { ...current, status: 'DISPUTE_REJECTED' };
      return json({ dispute_id: record.disputeId, dispute_status: current.status, webhook_enqueued: false, webhook_sent: false });
    }
    return json(url.endsWith('dispute%2F1') ? current : { disputes: [current] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<DisputesPanel shopId="shop-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'View dispute dispute/1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update status' }));
  const form = screen.getByRole('form', { name: 'Update dispute' });
  fireEvent.change(within(form).getByRole('combobox', { name: 'Status' }), { target: { value: 'DISPUTE_REJECTED' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Apply status' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Update status' })).toBeNull());
  const post = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ shop_id: 'shop-1', order_id: 'order-1', return_id: 'return-1', dispute_id: 'dispute/1', status: 'DISPUTE_REJECTED' });
});

it('rejects nonzero API codes even when HTTP succeeds', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 99, message: 'Dispute unavailable' }))));
  await expect(listDisputes()).rejects.toThrow('Dispute unavailable');
});

it('shows failures without automatically retrying a state change', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') throw new Error('Connection lost');
    return json({ disputes: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<DisputesPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'New dispute' }));
  const form = screen.getByRole('form', { name: 'Create dispute' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'Order ID' }), { target: { value: 'order-1' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Create dispute' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Refresh the list before submitting again');
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
