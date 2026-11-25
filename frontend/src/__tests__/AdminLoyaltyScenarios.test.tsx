import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrdersPanel } from '../features/orders.console';
import { CouponsPanel } from '../features/coupons.console';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const setup = () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return json(url.endsWith('loyalty-orders') ? { orders: [{ label: 'boundary', orderId: 'order-1', status: 'COMPLETED' }] } : { batches: [{ title: 'Custom tier', codes: [{ id: 'code-1' }] }] });
    return json({ items: [], next: '' });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('configures the buyer and completion threshold before creating loyalty orders', async () => {
  const fetcher = setup();
  render(<OrdersPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create loyalty orders' }));
  expect(fetcher.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0);
  const threshold = screen.getByRole('spinbutton', { name: 'Completion threshold (days)' });
  const generate = screen.getByRole('button', { name: 'Generate loyalty orders' });
  expect((threshold as HTMLInputElement).value).toBe('15');
  for (const value of ['0', '366', '1.5', '']) {
    fireEvent.change(threshold, { target: { value } });
    expect(generate.hasAttribute('disabled')).toBe(true);
  }
  fireEvent.change(threshold, { target: { value: '365' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Buyer ID (optional)' }), { target: { value: ' buyer-2 ' } });
  fireEvent.click(generate);
  await screen.findByText(/Created 1 loyalty test orders/);
  const [url, options] = fetcher.mock.calls.find(([, opts]) => opts?.method === 'POST')!;
  expect(url).toBe('/test-admin/scenarios/loyalty-orders');
  expect(JSON.parse(options!.body as string)).toEqual({ shopId: 'shop-1', buyerId: 'buyer-2', thresholdDays: 365 });
});

it('omits an empty buyer selection so the API selects the first buyer', async () => {
  const fetcher = setup();
  render(<OrdersPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create loyalty orders' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate loyalty orders' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(true));
  expect(JSON.parse(fetcher.mock.calls.find(([, opts]) => opts?.method === 'POST')![1]!.body as string)).toEqual({ shopId: 'shop-1', thresholdDays: 15 });
});

it('configures voucher tiers, quantity, validity and discount caps with API limits', async () => {
  const fetcher = setup();
  render(<CouponsPanel shopId="shop-2" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create loyalty voucher batches' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove tier 3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove tier 2' }));
  const submit = screen.getByRole('button', { name: 'Generate voucher batches' });
  const quantity = screen.getByRole('spinbutton', { name: 'Codes per tier' });
  const days = screen.getByRole('spinbutton', { name: 'Validity (days)' });
  const percentage = screen.getByRole('spinbutton', { name: 'Tier 1 percent off' });
  const cap = screen.getByRole('spinbutton', { name: 'Tier 1 maximum discount (VND, optional)' });
  for (const [input, invalid, valid] of [[quantity, '501', '500'], [days, '366', '365'], [percentage, '101', '100'], [cap, '2000000001', '2000000000']] as const) {
    fireEvent.change(input, { target: { value: invalid } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: valid } });
  }
  fireEvent.change(screen.getByRole('textbox', { name: 'Tier 1 name' }), { target: { value: '  Gold  ' } });
  fireEvent.click(submit);
  await screen.findByText('Created Custom tier (1 codes)');
  const [url, options] = fetcher.mock.calls.find(([, opts]) => opts?.method === 'POST')!;
  expect(url).toBe('/test-admin/scenarios/loyalty-vouchers');
  expect(JSON.parse(options!.body as string)).toEqual({ shopId: 'shop-2', quantityPerTier: 500, validDays: 365, tiers: [{ name: 'Gold', percentage: 100, maxDiscountVnd: 2000000000 }] });
});

it('submits the default test tiers without optional caps', async () => {
  const fetcher = setup();
  render(<CouponsPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create loyalty voucher batches' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate voucher batches' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(true));
  expect(JSON.parse(fetcher.mock.calls.find(([, opts]) => opts?.method === 'POST')![1]!.body as string)).toEqual({ shopId: 'shop-1', quantityPerTier: 20, validDays: 30, tiers: [{ name: 'Silver', percentage: 10 }, { name: 'Platinum', percentage: 20 }, { name: 'Diamond', percentage: 30 }] });
});

it('does not retry creation automatically after a lost response', async () => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') throw new Error(`Network lost: ${url}`);
    return json({ items: [], next: '' });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CouponsPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create loyalty voucher batches' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate voucher batches' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Check the coupon list before submitting again');
  expect(fetcher.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});
