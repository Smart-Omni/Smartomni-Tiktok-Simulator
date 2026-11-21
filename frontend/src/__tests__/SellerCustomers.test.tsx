import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth';
import { SellerCustomers } from '@/pages/seller-center/SellerCustomers';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const auth = (shopId: string) => ({ seller: { role: 'SELLER' as const, shopId, sessionToken: `token-${shopId}`, buyerId: null, expiresAt: '2099-01-01' }, buyer: null, session: vi.fn(), signIn: vi.fn(), signOut: vi.fn() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('loads customers with the seller session and searches real names, city and IDs across pages', async () => {
  vi.mocked(useAuth).mockReturnValue(auth('shop/1'));
  const fetcher = vi.fn(async () => json({ items: Array.from({ length: 12 }, (_, i) => ({ id: `buyer-${i + 1}`, name: i === 11 ? 'Đặng Thị Hà' : `Customer ${i + 1}`, city: 'Hà Nội' })) }));
  vi.stubGlobal('fetch', fetcher);
  render(<SellerCustomers />);
  await screen.findByText('Customer 1');
  expect(fetcher).toHaveBeenCalledWith('/demo/shops/shop%2F1/buyers', expect.objectContaining({ headers: { 'x-demo-session': 'token-shop/1' } }));
  expect(screen.queryByText('Đặng Thị Hà')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('Đặng Thị Hà')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search customers' }), { target: { value: 'dang thi ha' } });
  expect(screen.getByText('Đặng Thị Hà')).toBeTruthy();
  expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search customers' }), { target: { value: 'not-found' } });
  expect(screen.getByText('No customers match your search.')).toBeTruthy();
});

it('clears customer data and search when the seller changes shops', async () => {
  vi.mocked(useAuth).mockReturnValue(auth('shop-1'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json({ items: [{ id: url.includes('shop-1') ? 'b1' : 'b2', name: url.includes('shop-1') ? 'First shop buyer' : 'Second shop buyer', city: 'Hanoi' }] })));
  const view = render(<SellerCustomers />);
  await screen.findByText('First shop buyer');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search customers' }), { target: { value: 'First' } });
  vi.mocked(useAuth).mockReturnValue(auth('shop-2'));
  view.rerender(<SellerCustomers />);
  expect(screen.queryByText('First shop buyer')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Search customers' }) as HTMLInputElement).value).toBe('');
  expect(await screen.findByText('Second shop buyer')).toBeTruthy();
});

it('shows backend failure and recovers with retry without substituting customer data', async () => {
  vi.mocked(useAuth).mockReturnValue(auth('shop-1'));
  const fetcher = vi.fn().mockResolvedValueOnce(json({ message: 'Access denied' }, 403)).mockResolvedValueOnce(json({ items: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<SellerCustomers />);
  expect((await screen.findByRole('alert')).textContent).toContain('Access denied');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No customers in this shop yet.')).toBeTruthy();
});
