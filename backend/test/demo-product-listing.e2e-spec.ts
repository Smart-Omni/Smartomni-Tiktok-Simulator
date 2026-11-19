import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { attributesFor } from '../src/catalog-meta';
import fashion from '../src/seed/fashion-catalog.json';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';
import { pngBytes } from './images';
import { TiktokTestClient } from './tiktok-client';

/** A seeded leaf whose attributes include a required one ("Quốc gia xuất xứ" in the shared catalog data). */
const SEEDED_LEAF = '804616';

describe('Seller Center product listing fields (/demo catalog with images, category, brand, attributes)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
    t = new TiktokTestClient(http, app.get<AppConfig>(APP_CONFIG));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
  });

  const upload = async (s: { token: string; shopId: string }, w = 640, h = 640) =>
    (await http.post(`/demo/shops/${s.shopId}/media/images`).set('x-demo-session', s.token).attach('file', pngBytes(w, h), 'p.png').expect(201)).body as { uri: string; url: string };

  const required = attributesFor(SEEDED_LEAF).filter((a) => a.is_requried);
  const requiredValues = () => required.map((a) => (a.values.length ? { id: a.id, values: [{ id: a.values[0].id }] } : { id: a.id, values: [{ name: 'Viet Nam' }] }));
  const sku = { sellerSku: 'NEW-1', name: 'Default', priceVnd: 150000 };

  it('serves the category tree, attributes, rules and brands from the shared data', async () => {
    const s = await t.sellerSession(0);
    const auth = { 'x-demo-session': s.token };
    const tree = (await http.get(`/demo/shops/${s.shopId}/catalog/categories`).set(auth).expect(200)).body.categories;
    const fashion = tree.find((c: any) => c.id === '100001');
    expect(fashion).toMatchObject({ name: 'Thời trang & Phụ kiện', isLeaf: false });
    expect(fashion.children.map((c: any) => c.id)).toEqual(['100002', '100003', '100004']);
    expect(tree.some((c: any) => c.id === '500001')).toBe(false); // INVITE_ONLY is not offered

    const attrs = (await http.get(`/demo/shops/${s.shopId}/catalog/categories/${SEEDED_LEAF}/attributes`).set(auth).expect(200)).body.attributes;
    expect(attrs.filter((a: any) => a.isRequired).map((a: any) => a.id)).toEqual(required.map((a) => a.id));
    expect(attrs[0]).toHaveProperty('isCustomizable');

    expect((await http.get(`/demo/shops/${s.shopId}/catalog/categories/200002/rules`).set(auth).expect(200)).body).toEqual({ packageDimensionsRequired: true, sizeChartSupported: false, codSupported: true });
    await http.get(`/demo/shops/${s.shopId}/catalog/categories/100001/attributes`).set(auth).expect(400);
    await http.get(`/demo/shops/${s.shopId}/catalog/categories/999999/rules`).set(auth).expect(404);

    const brands = (await http.get(`/demo/shops/${s.shopId}/catalog/brands`).set(auth).expect(200)).body.brands;
    expect(brands).toContainEqual({ id: 'brand_004', name: 'Apple', authorized: false });

    const other = await t.sellerSession(1);
    await http.get(`/demo/shops/${s.shopId}/catalog/categories`).set('x-demo-session', other.token).expect(403);
  });

  it('creates a product with real images, then the storefront and TikTok Get Product return them', async () => {
    const { seller: s, accessToken } = await t.connect(0);
    const [img1, img2] = [await upload(s, 800, 800), await upload(s, 600, 400)];
    const created = await http
      .post(`/demo/shops/${s.shopId}/catalog/products`)
      .set('x-demo-session', s.token)
      .send({
        title: 'Bộ vét bé gái',
        description: 'Cotton',
        categoryId: SEEDED_LEAF,
        brandId: 'brand_003',
        images: [img2.uri, img1.uri],
        productAttributes: requiredValues(),
        packageWeight: { value: 0.4 },
        packageDimensions: { length: 30, width: 20, height: 5 },
        skus: [sku],
      })
      .expect(201);
    const p = created.body;
    expect(p.images.map((i: any) => i.uri)).toEqual([img2.uri, img1.uri]);
    expect(p.images[0]).toMatchObject({ url: img2.url, width: 600, height: 400 });
    expect(p).toMatchObject({ categoryId: SEEDED_LEAF, brandId: 'brand_003', packageWeight: { value: 0.4, unit: 'KILOGRAM' }, packageDimensions: { length: 30, width: 20, height: 5, unit: 'CENTIMETER' } });
    expect(p.categoryPath.map((c: any) => c.id)).toEqual(['802184', '803592', SEEDED_LEAF]);
    expect(p.productAttributes[0]).toMatchObject({ id: required[0].id, name: required[0].name });

    const front = await http.get(`/demo/catalog/${s.shopId}/${p.externalId}`).expect(200);
    expect(front.body.product.images).toEqual([img2.url, img1.url]);
    expect(front.body.product.imageUrl).toBe(img2.url);

    const detail = await t.call('GET', `/product/202309/products/${p.externalId}`, accessToken).expect(200);
    expect(detail.body.data.main_images[0]).toMatchObject({ uri: img2.uri, urls: [img2.url], width: 600, height: 400 });
    expect(detail.body.data.package_dimensions).toEqual({ length: '30', width: '20', height: '5', unit: 'CENTIMETER' });
    expect(detail.body.data.category_chains.at(-1).id).toBe(SEEDED_LEAF);
    expect(detail.body.data.brand).toEqual({ id: 'brand_003', name: 'SmartOmni' });

    // the served bytes are the uploaded ones
    await http.get(new URL(img2.url).pathname).expect(200).expect('content-type', 'image/png');
  });

  it('rejects a missing required attribute, a non-leaf category, a foreign image and missing dimensions', async () => {
    const s = await t.sellerSession(0);
    const other = await t.sellerSession(1);
    const mine = await upload(s);
    const theirs = await upload(other);
    const post = (body: Record<string, unknown>) => http.post(`/demo/shops/${s.shopId}/catalog/products`).set('x-demo-session', s.token).send({ title: 'X', skus: [sku], ...body });

    expect((await post({ categoryId: SEEDED_LEAF, images: [mine.uri] }).expect(400)).body.message).toContain(`${required[0].name} is required`);
    expect((await post({ categoryId: '100001', images: [mine.uri] }).expect(400)).body.message).toContain('leaf category');
    expect((await post({ categoryId: '400001', images: [theirs.uri] }).expect(400)).body.message).toContain('uploaded by this shop');
    expect((await post({ categoryId: '400001', images: ['https://example.com/a.jpg'] }).expect(400)).body.message).toContain('uri values returned');
    expect((await post({ categoryId: '200002', images: [mine.uri] }).expect(400)).body.message).toContain('package_dimensions is required');
    expect((await post({ categoryId: '100002', images: [mine.uri], productAttributes: [{ id: 'attr_material', values: [{ name: 'Cotton' }] }] }).expect(201)).body.categoryId).toBe('100002');
    expect((await post({ brandId: 'brand_999' }).expect(400)).body.message).toContain('brand_id');
    expect((await post({ categoryId: '400001', productAttributes: [{ id: 'nope', values: [{ name: 'x' }] }] }).expect(400)).body.message).toContain('does not belong');
    await post({ images: [] }).expect(400);
    await post({ images: Array(10).fill(mine.uri) }).expect(400);
  });

  it('saves a seeded product unchanged the way the product page sends it (stored external images are kept)', async () => {
    const ids = (await http.get('/demo/identities').expect(200)).body;
    const seller = ids.sellers.find((s: any) => s.shops.some((sh: any) => sh.name === fashion.shops[0].name));
    const sess = (await http.post('/demo/sessions').send({ role: 'SELLER', sellerId: seller.id }).expect(201)).body;
    const auth = { 'x-demo-session': sess.sessionToken };
    const list = (await http.get(`/demo/shops/${sess.shopId}/catalog`).set(auth).expect(200)).body.items;
    const p = list.find((x: any) => x.images.length > 0 && x.categoryId);
    expect(p.images[0].uri).toMatch(/^https?:\/\//);
    const body = {
      title: p.title,
      description: p.description,
      categoryId: p.categoryId,
      brandId: p.brandId ?? null,
      images: p.images.map((i: any) => i.uri),
      productAttributes: p.productAttributes.map((a: any) => ({ id: a.id, values: a.values.map((v: any) => (v.id ? { id: v.id, name: v.name } : { name: v.name })) })),
      packageWeight: p.packageWeight ? { value: p.packageWeight.value, unit: 'KILOGRAM' } : null,
      packageDimensions: null,
    };
    const saved = (await http.patch(`/demo/shops/${sess.shopId}/catalog/products/${p.id}`).set(auth).send(body).expect(200)).body;
    expect(saved.images).toEqual(p.images);
    expect(saved.packageWeight).toEqual(p.packageWeight);
    expect(saved.productAttributes.map((a: any) => a.id)).toEqual(p.productAttributes.map((a: any) => a.id));

    // a new upload can be added in front of the stored image
    const img = (await http.post(`/demo/shops/${sess.shopId}/media/images`).set(auth).attach('file', pngBytes(300, 300), 'n.png').expect(201)).body;
    const more = (await http.patch(`/demo/shops/${sess.shopId}/catalog/products/${p.id}`).set(auth).send({ images: [img.uri, ...body.images] }).expect(200)).body;
    expect(more.images.map((i: any) => i.uri)).toEqual([img.uri, ...body.images]);
  });

  it('edits listing fields; a new category drops the old attributes and title-only edits skip the listing checks', async () => {
    const s = await t.sellerSession(0);
    const img = await upload(s);
    const p = (await http.post(`/demo/shops/${s.shopId}/catalog/products`).set('x-demo-session', s.token).send({ title: 'Ao', skus: [sku], categoryId: SEEDED_LEAF, images: [img.uri], productAttributes: requiredValues() }).expect(201)).body;
    const patch = (body: Record<string, unknown>) => http.patch(`/demo/shops/${s.shopId}/catalog/products/${p.id}`).set('x-demo-session', s.token).send(body);

    expect((await patch({ title: 'Ao moi' }).expect(200)).body.title).toBe('Ao moi');
    const moved = (await patch({ categoryId: '400001' }).expect(200)).body;
    expect(moved).toMatchObject({ categoryId: '400001', productAttributes: [] });
    expect(moved.images.map((i: any) => i.uri)).toEqual([img.uri]);
    expect((await patch({ categoryId: SEEDED_LEAF }).expect(400)).body.message).toContain('is required');
    const cleared = (await patch({ brandId: null, packageWeight: { value: 1.5 } }).expect(200)).body;
    expect(cleared).toMatchObject({ brandId: null, packageWeight: { value: 1.5, unit: 'KILOGRAM' } });
    expect((await patch({ packageWeight: null }).expect(200)).body.packageWeight).toBeNull();
  });
});
