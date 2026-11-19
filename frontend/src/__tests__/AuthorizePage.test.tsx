import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizePage } from '../pages/AuthorizePage';

const consent = {
  app: { appKey: 'k', name: 'SmartOmni (dev)' },
  shop: { id: 's1', name: 'Shop A', region: 'VN', currency: 'VND' },
  scopes: ['sim.authorized_shops.read'],
  redirectUri: 'http://localhost:8080/cb',
  state: 'st',
};

describe('AuthorizePage', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    calls.length = 0;
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify({ sessionToken: 'tok', role: 'SELLER', shopId: 's1', buyerId: null, expiresAt: '2999-01-01T00:00:00Z' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const body = init?.method === 'POST' ? { decision: 'x', redirectUrl: 'http://localhost:8080/cb?code=C&state=st' } : consent;
        return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows shop and scopes, and navigates to the URL returned by the API on accept', async () => {
    const navigate = vi.fn();
    render(<MemoryRouter initialEntries={['/seller/authorize?app_key=k&state=st']}><AuthorizePage navigate={navigate} /></MemoryRouter>);
    expect(await screen.findByText('Shop A')).toBeTruthy();
    expect(screen.getByText('sim.authorized_shops.read')).toBeTruthy();
    fireEvent.click(screen.getByText('Authorize'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('http://localhost:8080/cb?code=C&state=st'));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(post.init!.body as string)).toMatchObject({ app_key: 'k', state: 'st', decision: 'accept' });
  });

  it('sends deny and reports a missing app_key', async () => {
    const navigate = vi.fn();
    const { unmount } = render(<MemoryRouter initialEntries={['/seller/authorize?app_key=k']}><AuthorizePage navigate={navigate} /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Deny'));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init!.body as string).decision).toBe('deny');
    unmount();
    render(<MemoryRouter initialEntries={['/seller/authorize']}><AuthorizePage navigate={navigate} /></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toMatch(/Missing app_key/);
  });

  it.each([
    ['Authorize', 'accept', 'smartomni://oauth/tiktok?code=C&state=st'],
    ['Deny', 'deny', 'smartomni://oauth/tiktok?error=access_denied&state=st'],
  ])('sends the mobile redirect and navigates to the API URL on %s', async (button, decision, redirectUrl) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = init?.method === 'POST' ? { decision, redirectUrl } : { ...consent, redirectUri: 'smartomni://oauth/tiktok' };
      return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    }));
    const navigate = vi.fn();
    render(<MemoryRouter initialEntries={['/seller/authorize?app_key=k&state=st&redirect_uri=smartomni%3A%2F%2Foauth%2Ftiktok']}><AuthorizePage navigate={navigate} /></MemoryRouter>);
    expect(await screen.findByText('smartomni://oauth/tiktok')).toBeTruthy();
    fireEvent.click(screen.getByText(button));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(redirectUrl));
    expect(calls[0].url).toContain('redirect_uri=smartomni%3A%2F%2Foauth%2Ftiktok');
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init!.body as string)).toMatchObject({ redirect_uri: 'smartomni://oauth/tiktok', decision });
  });
});
