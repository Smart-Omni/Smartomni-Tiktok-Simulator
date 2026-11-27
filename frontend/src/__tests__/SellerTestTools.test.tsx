import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestToolsButton, TestToolsFrame } from '@/components/seller/TestTools';
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
