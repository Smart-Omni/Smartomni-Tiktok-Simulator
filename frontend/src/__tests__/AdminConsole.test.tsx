import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConsolePage } from '../pages/ConsolePage';
import { MemoryRouter } from 'react-router-dom';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('clears SKU selections when the Admin switches shops, so a previous shop cannot be submitted', async () => {
  const shops = ['shop-1', 'shop-2'].map((id) => ({ id, name: id, status: 'ACTIVE', counts: { products: 1, buyers: 1, webhookJobs: 0 } }));
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/test-admin/shops') return json({ items: shops });
    if (url === '/test-admin/status') return json({ database: { status: 'up', name: 'simulator' }, worker: { running: true }, clock: { now: '2026-11-20T12:00:00Z', offsetMs: 0 }, webhookJobs: {}, seed: { shops: 2 } });
    if (url.startsWith('/test-admin/sandbox/products')) return json({ products: [{ product_id: 'p', title: 'Shirt', sku_list: [{ id: 'sku', seller_sku: 'SHIRT', price: 10, stock_count: 10 }] }], limits: { max_quantity_per_sku: 20, max_order_count: 10 } });
    return json({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<MemoryRouter><ConsolePage /></MemoryRouter>);
  await screen.findByText('simulator');
  const nav = screen.getByRole('navigation', { name: 'Test Console navigation' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Create test orders' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select SHIRT' }));
  const createButton = screen.getAllByRole('button', { name: 'Create test orders' }).find((button) => button.getAttribute('type') === 'submit') as HTMLButtonElement;
  expect(createButton.disabled).toBe(false);
  fireEvent.change(screen.getByRole('combobox', { name: 'Selected shop' }), { target: { value: 'shop-2' } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/test-admin/sandbox/products?shopId=shop-2', expect.anything()));
  expect((await screen.findByRole('checkbox', { name: 'Select SHIRT' }) as HTMLInputElement).checked).toBe(false);
  const createButtons = screen.getAllByRole('button', { name: 'Create test orders' });
  expect((createButtons[createButtons.length - 1] as HTMLButtonElement).disabled).toBe(true);
});
