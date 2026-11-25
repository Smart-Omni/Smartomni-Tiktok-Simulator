import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FaultsPanel } from '../pages/console/FaultsPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('validates and sends the webhook reorder hold time within API limits', async () => {
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  render(<FaultsPanel shopId="shop-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'New fault' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'REORDER' } });
  const hold = screen.getByRole('spinbutton', { name: 'Hold ms' });
  expect((hold as HTMLInputElement).value).toBe('5000');
  const add = screen.getByRole('button', { name: 'Add fault' });
  for (const invalid of ['', '-1', '600001', '0.5']) {
    fireEvent.change(hold, { target: { value: invalid } });
    expect(add.hasAttribute('disabled')).toBe(true);
  }
  fireEvent.change(hold, { target: { value: '600000' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Topic' }), { target: { value: 'ORDER_STATUS_CHANGE' } });
  fireEvent.click(add);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1));
  const [, options] = fetcher.mock.calls.find(([, opts]) => opts?.method === 'POST')!;
  expect(JSON.parse(options!.body as string)).toEqual({ shopId: 'shop-1', target: 'WEBHOOK', kind: 'REORDER', pathMatch: 'ORDER_STATUS_CHANGE', params: { holdMs: 600000 }, remaining: 1 });
  await screen.findByRole('button', { name: 'Add fault' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Target' }), { target: { value: 'API' } });
  expect((screen.getByRole('combobox', { name: 'Kind' }) as HTMLSelectElement).value).toBe('HTTP_ERROR');
  expect(screen.queryByRole('spinbutton', { name: 'Hold ms' })).toBeNull();
});
