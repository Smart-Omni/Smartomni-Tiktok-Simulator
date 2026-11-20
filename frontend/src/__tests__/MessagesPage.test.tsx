import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession } from '@/lib/types';
import { MessagesPage } from '@/pages/shop/MessagesPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };
const base = '/demo/shops/shop-1';
const msg = (id: string, role: string, text: string) => ({ id, index: 1, type: 'TEXT', role, roleLabel: role === 'BUYER' ? 'Buyer' : 'Shop', nickname: 'x', at: future, text, supported: true });
const conversation = { id: 'c1', externalId: 'e1', buyerNickname: 'An', agentJoined: false, canSendMessage: true, unread: 0, latest: null, updatedAt: future };

describe('Buyer messages', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let conversations: unknown[];
  beforeEach(() => {
    calls.length = 0;
    conversations = [];
    sessionStorage.clear();
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'POST') return json({}, 201);
        if (url === '/demo/identities') {
          return json({
            sellers: [
              { id: 's1', name: 'Seller One', shops: [{ id: 'shop-1', name: 'Mộc Lan Shop' }] },
              { id: 's2', name: 'Seller Two', shops: [{ id: 'shop-2', name: 'Pottery Shop' }] },
            ],
            buyers: [],
          });
        }
        if (url === '/demo/shops/shop-2/chat/conversations') return json({ supportedTypes: ['TEXT'], unsupported: 'IMAGE, VIDEO', items: [] });
        if (url === `${base}/chat/conversations`) return json({ supportedTypes: ['TEXT'], unsupported: 'IMAGE, VIDEO', items: conversations });
        if (url === `${base}/chat/conversations/c1/messages`) return json({ conversation, items: [msg('m1', 'BUYER', 'Is size L back?'), msg('m2', 'SHOP', 'Yes, today.')] });
        return json({ message: 'nope' }, 404);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderPage = (path = '/') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <MessagesPage />
        </AuthProvider>
      </MemoryRouter>,
    );

  it('starts a conversation with the shop through POST chat/messages', async () => {
    renderPage();
    const thread = await screen.findByRole('region', { name: 'Chat thread' });
    expect(within(thread).getByText('Say hello to start a conversation.')).toBeTruthy();
    const send = within(thread).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: 'Hello shop' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: `${base}/chat/messages`, method: 'POST', body: { text: 'Hello shop' } }]));
  });

  it('chats with the shop picked in ?shop= and sends the message to that shop', async () => {
    renderPage('/?shop=shop-2');
    const thread = await screen.findByRole('region', { name: 'Chat thread' });
    expect((await screen.findByRole('button', { name: 'Pottery Shop' })).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi Pottery' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/demo/shops/shop-2/chat/messages', method: 'POST', body: { text: 'Hi Pottery' } }]));
  });

  it('shows the conversation, own messages on the right, and replies in it', async () => {
    conversations = [conversation];
    renderPage();
    const thread = await screen.findByRole('region', { name: 'Chat thread' });
    const items = await within(thread).findAllByRole('listitem');
    expect(items.map((li) => li.className.includes('self-end'))).toEqual([true, false]);
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: 'Thanks' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: `${base}/chat/conversations/c1/messages`, method: 'POST', body: { text: 'Thanks' } }]));
  });

  it('filters shops and clears the previous draft when switching shops', async () => {
    renderPage();
    const thread = await screen.findByRole('region', { name: 'Chat thread' });
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Message' }), { target: { value: 'Draft for Mộc Lan' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search shops' }), { target: { value: 'pottery' } });
    expect(screen.queryByRole('button', { name: 'Mộc Lan Shop' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Pottery Shop' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hi new shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/demo/shops/shop-2/chat/messages', method: 'POST', body: { text: 'Hi new shop' } }]));
  });
});
