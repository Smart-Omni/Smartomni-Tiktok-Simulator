import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ShopsPanel } from '../pages/console/ShopsPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const shops = {
  loading: false, error: undefined, reload: vi.fn(),
  data: { items: ['a', 'b'].map((id) => ({ id, name: `Shop ${id}`, region: 'VN', currency: 'VND', status: 'ACTIVE', tiktokShopId: id, activeScenarioId: null, scenarios: [], counts: { products: 0, buyers: 0, webhookJobs: 0 } })) },
};

it('keeps settings per shop, blocks invalid counts and sends the requested product and SKU counts', async () => {
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ created: 3, totalProducts: 3 }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  render(<ShopsPanel shops={shops} />);
  const form = within(screen.getByRole('form', { name: 'Create test products for Shop b' }));
  const products = form.getByRole('spinbutton', { name: 'Products to create' });
  const skus = form.getByRole('spinbutton', { name: 'SKUs per product' });
  for (const value of ['0', '501', '1.5', '']) {
    fireEvent.change(products, { target: { value } });
    expect(form.getByRole('button').hasAttribute('disabled')).toBe(true);
  }
  fireEvent.change(products, { target: { value: '3' } });
  for (const value of ['0', '6', '1.5', '']) {
    fireEvent.change(skus, { target: { value } });
    expect(form.getByRole('button').hasAttribute('disabled')).toBe(true);
  }
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(skus, { target: { value: '5' } });
  expect((within(screen.getByRole('form', { name: 'Create test products for Shop a' })).getByLabelText('Products to create') as HTMLInputElement).value).toBe('50');
  fireEvent.click(form.getByRole('button', { name: 'Add 3 test products' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ shopId: 'b', count: 3, skusPerProduct: 5 });
  expect(await screen.findByText('Added 3 products to Shop b (3 in this shop).')).toBeTruthy();
});

it('does not retry a failed create request and warns about partial creation', async () => {
  const fetcher = vi.fn(async () => { throw new Error('offline'); });
  vi.stubGlobal('fetch', fetcher);
  render(<ShopsPanel shops={shops} />);
  fireEvent.click(within(screen.getByRole('form', { name: 'Create test products for Shop a' })).getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toContain('some products may already have been created');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
