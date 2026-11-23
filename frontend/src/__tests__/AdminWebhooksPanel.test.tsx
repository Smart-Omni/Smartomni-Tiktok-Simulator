import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebhooksPanel } from '../pages/console/WebhooksPanel';

const jobs = Array.from({ length: 12 }, (_, i) => ({
  id: `job-${i + 1}`, topic: `TOPIC_${i + 1}`, status: 'SUCCEEDED', attemptCount: 1, maxAttempts: 3,
  createdAt: '2026-11-20T12:00:00Z', nextAttemptAt: '2026-11-20T12:00:00Z', requestId: `request-${i + 1}`,
  replayOfId: null, lastError: null,
  attempts: [{ id: `attempt-${i}`, attemptNo: 1, status: 'SUCCEEDED', httpStatus: 200, workerId: 'worker-test', deliveries: 1 }],
}));
const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ items: jobs }), { headers: { 'content-type': 'application/json' } }));
beforeEach(() => { fetcher.mockClear(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('paginates locally and expands delivery history only on demand', async () => {
  render(<WebhooksPanel shopId="shop-1" />);
  await screen.findByText('TOPIC_1');
  expect(screen.queryByText('TOPIC_11')).toBeNull();
  expect(screen.queryByText(/worker-test/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View attempts for job-1' }));
  expect(screen.getByText(/worker-test/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('TOPIC_11')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves replay and queue request contracts', async () => {
  render(<WebhooksPanel shopId="shop-1" />);
  await screen.findByText('TOPIC_1');
  fireEvent.click(screen.getAllByRole('button', { name: 'Replay' })[0]);
  await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => url === '/test-admin/webhooks/job-1/replay' && options?.method === 'POST')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Queue webhook' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Topic' }), { target: { value: 'CUSTOM_TOPIC' } });
  fireEvent.click(screen.getByRole('button', { name: /^Queue$/ }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => url === '/test-admin/webhooks' && options?.method === 'POST')).toBe(true));
  const request = fetcher.mock.calls.find(([url]) => url === '/test-admin/webhooks')!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({ shopId: 'shop-1', topic: 'CUSTOM_TOPIC', targetUrl: 'http://host.docker.internal:9999/webhook', payload: { note: 'foundation test event' } });
});
