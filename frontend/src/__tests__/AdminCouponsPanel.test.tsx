import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CouponsPanel } from '../features/coupons.console';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps local pagination and status colors while loading and filtering voucher batches', async () => {
  const coupons = Array.from({ length: 11 }, (_, i) => ({
    id: `coupon-${i}`, promoCode: `CODE${i}`, title: `Voucher ${i}`, batchId: 'batch-1',
    status: 'ONGOING', redeemedCount: 0, redemptionLimit: 1,
    startAt: '2026-11-01', endAt: '2026-12-01', usages: [],
  }));
  const fetcher = vi.fn(async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const filtered = params.has('batchId');
    const more = params.has('after');
    return new Response(JSON.stringify({
      items: filtered ? [coupons[10]] : more ? [{ ...coupons[0], id: 'extra', promoCode: 'EXTRA' }] : coupons,
      next: filtered || more ? '' : 'cursor-1',
    }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CouponsPanel shopId="shop-1" />);
  await screen.findByText('CODE0');
  expect(screen.getAllByText('ONGOING')[0].getAttribute('data-tone')).toBeTruthy();
  expect(screen.queryByText('CODE10')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('CODE10')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('EXTRA');
  expect(fetcher.mock.calls.some(([url]) => url.includes('after=cursor-1'))).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter by batch' }), { target: { value: 'batch-1' } });
  await waitFor(() => expect(screen.queryByText('EXTRA')).toBeNull());
  expect(screen.getByText('CODE10')).toBeTruthy();
  expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url.includes('batchId=batch-1'))).toBe(true);
});

it('shows the totals of every code, not only the first page of 200', async () => {
  const page = Array.from({ length: 200 }, (_, i) => ({
    id: `c-${i}`, promoCode: `CODE${i}`, title: 'Loyalty Gold 10%', batchId: 'b-1',
    status: 'ONGOING', redeemedCount: i < 2 ? 1 : 0, redemptionLimit: 1,
    startAt: '2026-11-01', endAt: '2027-11-01', usages: [],
  }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: page, next: 'cursor-200', summary: { total: 300, ongoing: 299, redemptions: 3 } }), { headers: { 'content-type': 'application/json' } })));
  render(<CouponsPanel shopId="shop-1" />);
  const metrics = await screen.findByLabelText('Coupon summary');
  await waitFor(() => expect(metrics.textContent).toContain('Total codes300'));
  expect(metrics.textContent).toContain('Ongoing codes299');
  expect(metrics.textContent).toContain('Redemptions3');
  expect(screen.getByText('Showing 200 of 300 codes.')).toBeTruthy();
});
