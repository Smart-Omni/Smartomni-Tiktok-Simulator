import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { DemoSession } from '@/lib/types';
import { SellerProductForm } from '@/pages/seller-center/SellerProductForm';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const future = new Date(Date.now() + 24 * 3600_000).toISOString();
const seller: DemoSession = { sessionToken: 'tok-s', role: 'SELLER', shopId: 'shop-1', buyerId: null, expiresAt: future };
const base = '/demo/shops/shop-1';

const categories = {
  categories: [
    { id: 'c1', name: 'Fashion', isLeaf: false, children: [{ id: 'c2', name: 'Men tops', isLeaf: true, children: [] }, { id: 'c3', name: 'Phone cases', isLeaf: true, children: [] }] },
    { id: 'c9', name: 'Home', isLeaf: true, children: [] },
  ],
};
const attributes: Record<string, unknown> = {
  c2: {
    attributes: [
      { id: 'origin', name: 'Country of origin', isRequired: true, isMultipleSelection: false, isCustomizable: true, values: [{ id: 'vn', name: 'Vietnam' }] },
      { id: 'material', name: 'Material', isRequired: false, isMultipleSelection: false, isCustomizable: false, values: [{ id: 'cot', name: 'Cotton' }] },
    ],
  },
  c3: { attributes: [{ id: 'model', name: 'Phone model', isRequired: false, isMultipleSelection: true, isCustomizable: false, values: [{ id: 'ip', name: 'iPhone' }, { id: 'gx', name: 'Galaxy' }] }] },
  c9: { attributes: [] },
};
const rules = (dims: boolean) => ({ packageDimensionsRequired: dims, sizeChartSupported: false, codSupported: true });

const product = {
  id: 'row-p1',
  externalId: 'P1',
  title: 'Basic tee',
  description: 'Soft',
  status: 'ACTIVATE',
  isNotForSale: false,
  images: [{ uri: 'sim-media/a', url: 'http://api/demo/media/images/a', width: 600, height: 600 }],
  categoryId: 'c2',
  categoryPath: [{ id: 'c1', name: 'Fashion' }, { id: 'c2', name: 'Men tops' }],
  brandId: 'b1',
  productAttributes: [{ id: 'origin', name: 'Country of origin', values: [{ id: 'vn', name: 'Vietnam' }] }],
  packageWeight: { value: 0.3, unit: 'KILOGRAM' },
  packageDimensions: null,
  skus: [{ id: 'row-s1', externalId: 'S1', sellerSku: 'TEE-M', name: 'M', attributeName: 'Size', priceVnd: 129000, status: 'NORMAL', stock: [], totalStock: 3 }],
};

const writes: { url: string; method: string; body?: unknown }[] = [];
let uploadFails = false;
let uploadSeq = 0;
beforeEach(() => {
  writes.length = 0;
  uploadFails = false;
  uploadSeq = 0;
  sessionStorage.clear();
  sessionStorage.setItem('sim.demo-session.SELLER', JSON.stringify(seller));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => undefined }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === `${base}/media/images`) {
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
        if (uploadFails) return json({ message: 'Only JPEG, PNG or WebP images are accepted' }, 400);
        uploadSeq += 1;
        return json({ uri: `sim-media/u${uploadSeq}`, url: `http://api/demo/media/images/u${uploadSeq}`, width: 10, height: 10 }, 201);
      }
      if (method !== 'GET') {
        writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({}, 201);
      }
      if (url === `${base}/catalog`) return json({ currency: 'VND', warehouses: [{ externalId: 'w1', name: 'Kho HN' }], items: [product] });
      if (url === `${base}/catalog/categories`) return json(categories);
      if (url === `${base}/catalog/brands`) return json({ brands: [{ id: 'b1', name: 'SmartOmni', authorized: true }] });
      const m = url.match(/catalog\/categories\/(\w+)\/(attributes|rules)$/);
      if (m) return json(m[2] === 'attributes' ? attributes[m[1]] : rules(m[1] === 'c3'));
      return json({ message: `unexpected ${url}` }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/seller-center/products/new" element={<SellerProductForm />} />
          <Route path="/seller-center/products/:id/edit" element={<SellerProductForm />} />
          <Route path="/seller-center/products" element={<p>Products list</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const png = (name = 'a.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
const pickFiles = (files: File[]) => fireEvent.change(screen.getByTestId('image-input'), { target: { files } });

describe('Seller Center product page', () => {
  it('shows the attributes of the chosen category and drops values that do not fit a new one', async () => {
    renderAt('/seller-center/products/new');
    fireEvent.change(await screen.findByLabelText('Category level 1'), { target: { value: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Category level 2'), { target: { value: 'c2' } });
    const origin = await screen.findByLabelText('Country of origin *');
    expect(screen.getByLabelText('Material')).toBeTruthy();
    fireEvent.change(origin, { target: { value: 'Vietnam' } });

    fireEvent.change(screen.getByLabelText('Category level 2'), { target: { value: 'c3' } });
    expect(await screen.findByRole('group', { name: 'Phone model' })).toBeTruthy();
    expect(screen.queryByLabelText('Country of origin *')).toBeNull();
    expect(await screen.findByLabelText('Length (cm) *')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search categories'), { target: { value: 'home' } });
    fireEvent.click(within(screen.getByRole('list', { name: 'Matching categories' })).getByRole('button', { name: 'Home' }));
    expect(await screen.findByText('Selected: Home')).toBeTruthy();
  });

  it('validates before sending, uploads images as they are picked and creates the product', async () => {
    renderAt('/seller-center/products/new');
    const create = await screen.findByRole('button', { name: 'Create product' });
    fireEvent.click(create);
    expect(await screen.findByText('Enter a product title')).toBeTruthy();
    expect(screen.getByText('Add at least one image')).toBeTruthy();
    expect(screen.getByText('Choose a category')).toBeTruthy();
    expect(writes).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Linen shirt' } });
    pickFiles([png('one.png'), new File(['x'], 'anim.gif', { type: 'image/gif' })]);
    expect(await screen.findByText('anim.gif: only JPEG, PNG or WebP images')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('listitem', { name: 'Image 1 (main)' }).querySelector('img')?.getAttribute('src')).toBe('http://api/demo/media/images/u1'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 2' }));

    fireEvent.change(screen.getByLabelText('Category level 1'), { target: { value: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Category level 2'), { target: { value: 'c2' } });
    await screen.findByLabelText('Country of origin *');
    fireEvent.click(create);
    expect(await screen.findByText('Country of origin is required')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Country of origin *'), { target: { value: 'Vietnam' } });
    fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'Cotton' } });
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '0.25' } });
    fireEvent.change(screen.getByLabelText('Seller SKU 1'), { target: { value: 'LIN-1' } });
    fireEvent.change(screen.getByLabelText('Variant name 1'), { target: { value: 'White' } });
    fireEvent.change(screen.getByLabelText('Price 1'), { target: { value: '259000' } });
    fireEvent.click(create);

    await waitFor(() =>
      expect(writes).toEqual([
        {
          url: `${base}/catalog/products`,
          method: 'POST',
          body: {
            title: 'Linen shirt',
            description: '',
            categoryId: 'c2',
            brandId: null,
            images: ['sim-media/u1'],
            productAttributes: [
              { id: 'origin', values: [{ id: 'vn', name: 'Vietnam' }] },
              { id: 'material', values: [{ id: 'cot', name: 'Cotton' }] },
            ],
            packageWeight: { value: 0.25, unit: 'KILOGRAM' },
            packageDimensions: null,
            skus: [{ sellerSku: 'LIN-1', name: 'White', priceVnd: 259000 }],
          },
        },
      ]),
    );
    expect(await screen.findByText('Products list')).toBeTruthy();
  });

  it('keeps a failed upload out of the product and blocks saving until it is removed', async () => {
    uploadFails = true;
    renderAt('/seller-center/products/new');
    await screen.findByRole('button', { name: 'Create product' });
    pickFiles([png()]);
    expect(await screen.findByText('a.png: Only JPEG, PNG or WebP images are accepted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect(await screen.findByText(/remove the failed ones/)).toBeTruthy();
  });

  it('edits a stored product with its images, category and attributes', async () => {
    renderAt('/seller-center/products/row-p1/edit');
    expect(await screen.findByDisplayValue('Basic tee')).toBeTruthy();
    expect(await screen.findByDisplayValue('Vietnam')).toBeTruthy();
    expect(screen.getByText('Selected: Fashion > Men tops')).toBeTruthy();
    expect(screen.getByText(/TEE-M/)).toBeTruthy();
    pickFiles([png()]);
    await waitFor(() => expect(screen.getByRole('listitem', { name: 'Image 2' }).querySelector('img')?.getAttribute('src')).toBe('http://api/demo/media/images/u1'));
    fireEvent.click(screen.getByRole('button', { name: 'Move image 2 left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save product' }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          url: `${base}/catalog/products/row-p1`,
          method: 'PATCH',
          body: {
            title: 'Basic tee',
            description: 'Soft',
            categoryId: 'c2',
            brandId: 'b1',
            images: ['sim-media/u1', 'sim-media/a'],
            productAttributes: [{ id: 'origin', values: [{ id: 'vn', name: 'Vietnam' }] }],
            packageWeight: { value: 0.3, unit: 'KILOGRAM' },
            packageDimensions: null,
          },
        },
      ]),
    );
  });
});
