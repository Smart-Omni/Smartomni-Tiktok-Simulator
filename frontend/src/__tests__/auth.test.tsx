import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth, type AuthValue } from '@/lib/auth';
import { SESSION_CHANGED } from '@/lib/session';
import type { DemoSession } from '@/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyerSession: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };
const sellerSession: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };

let auth: AuthValue;
function Probe() {
  auth = useAuth();
  return <div>{`buyer:${auth.buyer?.buyerId ?? 'none'} seller:${auth.seller?.shopId ?? 'none'}`}</div>;
}
const renderAuth = () => render(<AuthProvider><Probe /></AuthProvider>);

describe('AuthProvider', () => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
        if (url === '/demo/sessions') return json(body.role === 'SELLER' ? sellerSession : buyerSession, 201);
        return new Response(null, { status: 204 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reads a session already stored by the legacy pages', () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyerSession));
    renderAuth();
    expect(screen.getByText('buyer:buyer_1 seller:none')).toBeTruthy();
  });

  it('ignores and clears an expired session', () => {
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify({ ...sellerSession, expiresAt: '2000-01-01T00:00:00.000Z' }));
    renderAuth();
    expect(screen.getByText('buyer:none seller:none')).toBeTruthy();
    expect(sessionStorage.getItem('sim.demo-session.SELLER')).toBeNull();
  });

  it('signIn posts the identity and stores the session under the legacy key', async () => {
    renderAuth();
    await act(() => auth.signIn({ role: 'SELLER', email: 'sellerone.ttsim@gmail.com', password: '123' }));
    expect(calls).toEqual([expect.objectContaining({ url: '/demo/sessions', method: 'POST', body: { role: 'SELLER', email: 'sellerone.ttsim@gmail.com', password: '123' } })]);
    expect(JSON.parse(sessionStorage.getItem('sim.demo-session.SELLER')!)).toEqual(sellerSession);
    expect(screen.getByText('buyer:none seller:shop-1')).toBeTruthy();
  });

  it('signOut ends the session on the API and clears only that role', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyerSession));
    sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(sellerSession));
    renderAuth();
    await act(() => auth.signOut('BUYER'));
    expect(calls).toEqual([expect.objectContaining({ url: '/demo/sessions/current', method: 'DELETE', headers: { 'x-demo-session': 'tok-b' } })]);
    expect(sessionStorage.getItem('sim.demo-session.BUYER')).toBeNull();
    expect(sessionStorage.getItem('sim.demo-session.SELLER')).not.toBeNull();
    expect(screen.getByText('buyer:none seller:shop-1')).toBeTruthy();
  });

  it('picks up a sign-in made by a legacy page', () => {
    renderAuth();
    act(() => {
      sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyerSession));
      window.dispatchEvent(new Event(SESSION_CHANGED));
    });
    expect(screen.getByText('buyer:buyer_1 seller:none')).toBeTruthy();
  });

  it('signs out locally even when the API call fails', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyerSession));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    renderAuth();
    await act(() => auth.signOut('BUYER'));
    expect(sessionStorage.getItem('sim.demo-session.BUYER')).toBeNull();
    expect(screen.getByText('buyer:none seller:none')).toBeTruthy();
  });
});
