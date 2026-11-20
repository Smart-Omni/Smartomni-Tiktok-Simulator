import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession, StorefrontProduct } from '@/lib/types';
import { mockCatalog, mockCategories } from '@/mocks';
import { HomePage } from '@/pages/shop/HomePage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const future = new Date(Date.now() + 3600_000).toISOString();
const buyer: DemoSession = { sessionToken: 'tok-b', role: 'BUYER', shopId: 'shop-1', buyerId: 'buyer_1', expiresAt: future };

const real = (id: string, title: string): StorefrontProduct => ({
  shop: { id: 'shop-2', name: 'Pottery Shop' },
  id,
  title,
  description: '',
  imageUrl: `/demo/media/products/${id}.svg`,
  minPriceVnd: 100000,
  maxPriceVnd: 100000,
  skus: [{ id: `${id}-s`, name: 'M', attributeName: 'Size', priceVnd: 100000, available: true, stock: 5 }],
});
const storefront = [real('750001', 'Bình giữ nhiệt 500ml'), ...Array.from({ length: 11 }, (_, i) => real(`7501${i}`, `Real item ${i + 1}`))];

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

const renderHome = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
        <Location />
      </AuthProvider>
    </MemoryRouter>,
  );


describe('HomePage', () => {
  const urls: { url: string; headers: Record<string, string> }[] = [];
  beforeEach(() => {
    urls.length = 0;
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return json({ currency: 'VND', items: storefront, nextCursor: null });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows guests one catalog with unique product links without calling the API', async () => {
    renderHome();
    await screen.findByText('1–10 of 10 products');
    const catalog = screen.getByRole('region', { name: 'Products' });
    expect(within(catalog).getAllByRole('link')).toHaveLength(mockCatalog.length);
    expect(new Set(within(catalog).getAllByRole('link').map((el) => el.getAttribute('href'))).size).toBe(mockCatalog.length);
    expect(urls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '6 products per row' }));
    expect(screen.getByRole('button', { name: '6 products per row' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(catalog).getAllByRole('link')).toHaveLength(mockCatalog.length);
    expect(urls).toEqual([]);
  });
  it('loads buyer products through the existing catalog endpoint and sorts prices', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    renderHome();
    await screen.findByText('1–12 of 12 products');
    const catalog = screen.getByRole('region', { name: 'Products' });
    expect(urls.map((u) => u.url)).toEqual(['/demo/catalog?limit=100']);
    expect(within(catalog).getAllByRole('link')).toHaveLength(12);
    fireEvent.change(screen.getByLabelText('Sort products'), { target: { value: 'price-low' } });
    expect(within(catalog).getAllByRole('link')[0].getAttribute('href')).toContain('/product/shop-2/');
  });
  it('filters categories and clears the selected category', async () => {
    renderHome();
    const row = screen.getByRole('region', { name: 'Categories' });
    expect(within(row).getAllByRole('link')).toHaveLength(mockCategories.length + 1);
    fireEvent.click(within(row).getByRole('link', { name: 'Electronics' }));
    expect(await screen.findByText('1–1 of 1 products')).toBeTruthy();
    const catalog = screen.getByRole('region', { name: 'Products' });
    expect(within(catalog).getAllByRole('link')).toHaveLength(1);
    fireEvent.click(within(row).getByRole('link', { name: 'Electronics' }));
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
  it('combines search and category and offers recovery for empty results', async () => {
    renderHome('/?q=tea&category=kitchenware');
    expect(await screen.findByText('1–1 of 1 products')).toBeTruthy();
    cleanup();
    renderHome('/?q=zzz');
    expect(await screen.findByText('No products match “zzz”.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear search' }).getAttribute('href')).toBe('/');
  });
  it('shows a sliding window of three consecutive page numbers', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    vi.stubGlobal('fetch', vi.fn(async () => json({ currency: 'VND', items: Array.from({ length: 97 }, (_, i) => real(`item-${i}`, `Item ${i}`)), nextCursor: null })));
    renderHome();
    await screen.findByText('1–16 of 97 products');
    const nav = within(screen.getByRole('navigation', { name: 'Product pages' }));
    const numbers = () => nav.getAllByRole('button', { name: /^Page \d+$/ }).map((el) => el.textContent);
    expect(numbers()).toEqual(['1', '2', '3']);
    fireEvent.click(nav.getByRole('button', { name: 'Page 3' }));
    expect(numbers()).toEqual(['2', '3', '4']);
    expect(nav.getByRole('button', { name: 'Page 3' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(nav.getByRole('button', { name: 'Page 4' }));
    fireEvent.click(nav.getByRole('button', { name: 'Page 5' }));
    fireEvent.click(nav.getByRole('button', { name: 'Page 6' }));
    fireEvent.click(nav.getByRole('button', { name: 'Page 7' }));
    expect(numbers()).toEqual(['5', '6', '7']);
    expect(nav.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
  });
  it('paginates 16 products in four columns and 18 in six columns', async () => {
    sessionStorage.setItem('sim.demo-session.BUYER', JSON.stringify(buyer));
    vi.stubGlobal('fetch', vi.fn(async () => json({ currency: 'VND', items: Array.from({ length: 25 }, (_, i) => real(`item-${i}`, `Item ${i}`)), nextCursor: null })));
    renderHome();
    await screen.findByText('1–16 of 25 products');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('17–25 of 25 products')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Products' })).getAllByRole('link')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByText('1–16 of 25 products')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '6 products per row' }));
    expect(screen.getByText('1–18 of 25 products')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Products' })).getAllByRole('link')).toHaveLength(18);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('19–25 of 25 products')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '4 products per row' }));
    expect(screen.getByText('1–16 of 25 products')).toBeTruthy();
  });
});
