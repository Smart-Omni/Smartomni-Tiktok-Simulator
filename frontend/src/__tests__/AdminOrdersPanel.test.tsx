import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrdersPanel } from '../features/orders.console';

const orders = Array.from({ length: 23 }, (_, i) => ({ id: `order-${i + 1}`, buyerName: `Buyer ${i + 1}`, units: 1, status: i === 0 ? 'ON_HOLD' : i === 22 ? 'COMPLETED' : 'UNPAID', releaseAt: null }));
const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ items: orders }), { headers: { 'content-type': 'application/json' } }));
beforeEach(() => { fetcher.mockClear(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('paginates loaded orders and resets the page when filtering', async () => {
  render(<OrdersPanel shopId="shop-1" />);
  await screen.findByRole('button', { name: 'View history of order-1' });
  expect(screen.queryByRole('button', { name: 'View history of order-11' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByRole('button', { name: 'View history of order-11' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'COMPLETED' } });
  expect(screen.getByRole('button', { name: 'View history of order-23' })).toBeTruthy();
  expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('keeps the original API status value when a readable action label is clicked', async () => {
  render(<OrdersPanel shopId="shop-1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Awaiting shipment' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => url === '/test-admin/orders/order-1/transition' && options?.method === 'POST')).toBe(true));
  const request = fetcher.mock.calls.find(([url]) => url === '/test-admin/orders/order-1/transition')!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({ to: 'AWAITING_SHIPMENT', shopId: 'shop-1' });
});
