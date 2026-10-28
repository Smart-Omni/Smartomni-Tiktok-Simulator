import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { computeApiSignature } from '../src/tiktok/signature';
import { cleanDb, createApp } from './helpers';

const SEARCH = '/product/202502/products/search';
const WAREHOUSES = '/logistics/202309/warehouses';
const detailPath = (id: string) => `/product/202309/products/${id}`;

describe('Phase 04: catalog (Search Products, Get Product, Get Warehouse List) and Seller/Buyer demo APIs', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let cfg: AppConfig;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
  });

  // ---------- helpers ----------
  async function sellerSession(index: 0 | 1) {
    const ids = (await http.get('/demo/identities')).body;
    const isA = (x: any) => x.shops.some((sh: any) => sh.name.includes('Mộc Lan'));
    const seller = index === 0 ? ids.sellers.find(isA) : ids.sellers.find((x: any) => !isA(x));
    const sess = (await http.post('/demo/sessions').send({ role: 'SELLER', sellerId: seller.id }).expect(201)).body;
    return { token: sess.sessionToken as string, shopId: sess.shopId as string };
  }
  async function buyerSession(index: 0 | 1) {
    const ids = (await http.get('/demo/identities')).body;
    const sellerSess = await sellerSession(index);
    const buyer = ids.buyers.find((b: any) => b.shopId === sellerSess.shopId);
    const sess = (await http.post('/demo/sessions').send({ role: 'BUYER', buyerId: buyer.id }).expect(201)).body;
    return { token: sess.sessionToken as string, shopId: sess.shopId as string };
  }
  async function connect(index: 0 | 1) {
    const s = await sellerSession(index);
    const res = await http
      .post('/demo/authorization/consent')
      .set('x-demo-session', s.token)
      .send({ app_key: cfg.seed.appKey, decision: 'accept', state: 's' })
      .expect(201);
    const code = new URL(res.body.redirectUrl).searchParams.get('code')!;
    const tok = await http.get('/api/v2/token/get').query({ app_key: cfg.seed.appKey, app_secret: cfg.seed.appSecret, auth_code: code, grant_type: 'authorized_code' }).expect(200);
    return { seller: s, accessToken: tok.body.data.access_token as string };
  }

  /** Signed call, body signed exactly as sent (raw JSON text appended to the string to sign). */
  function call(method: 'GET' | 'POST', path: string, accessToken: string, opts: { query?: Record<string, string>; body?: unknown; rawBody?: string; secret?: string } = {}) {
    const q: Record<string, string> = { app_key: cfg.seed.appKey, timestamp: String(Math.floor(Date.now() / 1000)), ...(opts.query ?? {}) };
    const raw = opts.rawBody ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
    q.sign = computeApiSignature(opts.secret ?? cfg.seed.appSecret, path, q, raw);
    const r = method === 'GET' ? http.get(path) : http.post(path);
    r.query(q).set('x-tts-access-token', accessToken).set('content-type', 'application/json');
    return method === 'POST' ? r.send(raw) : r;
  }
  const search = (token: string, query: Record<string, string> = { page_size: '100' }, body: unknown = {}) => call('POST', SEARCH, token, { query, body });

  async function crawl(token: string, pageSize: number, body: unknown = {}) {
    const ids: string[] = [];
    let pageToken = '';
    let pages = 0;
    do {
      const res = await search(token, { page_size: String(pageSize), ...(pageToken ? { page_token: pageToken } : {}) }, body).expect(200);
      ids.push(...res.body.data.products.map((p: any) => p.id));
      pageToken = res.body.data.next_page_token;
      pages++;
      if (pages > 200) throw new Error('cursor did not terminate');
    } while (pageToken);
    return { ids, pages };
  }

  async function addProducts(session: { token: string; shopId: string }, n: number, prefix = 'Bulk') {
    for (let i = 0; i < n; i++) {
      await http
        .post(`/demo/shops/${session.shopId}/catalog/products`)
        .set('x-demo-session', session.token)
        .send({ title: `${prefix} ${i}`, skus: [{ sellerSku: `${prefix}-${i}`, name: 'Default', priceVnd: 10000 + i }] })
        .expect(201);
    }
  }

  // ---------- signed POST ----------
  describe('signed POST body', () => {
    it('accepts a body signed as sent and rejects a body changed after signing', async () => {
      const { accessToken } = await connect(0);
      await search(accessToken).expect(200);

      const body = JSON.stringify({ status: 'ACTIVATE' });
      const q: Record<string, string> = { app_key: cfg.seed.appKey, timestamp: String(Math.floor(Date.now() / 1000)), page_size: '10' };
      q.sign = computeApiSignature(cfg.seed.appSecret, SEARCH, q, body);
      const tampered = await http.post(SEARCH).query(q).set('x-tts-access-token', accessToken).set('content-type', 'application/json').send(JSON.stringify({ status: 'DELETED' }));
      expect(tampered.status).toBe(401);
      expect(tampered.body.simulator_fault.kind).toBe('bad_signature');
      await call('POST', SEARCH, accessToken, { query: { page_size: '10' }, rawBody: body }).expect(200);
    });

    it('signs the body as raw bytes, including non-ASCII text and whitespace', async () => {
      const { accessToken } = await connect(0);
      await call('POST', SEARCH, accessToken, { query: { page_size: '10' }, rawBody: '{ "seller_skus" : ["Đ-É"] }' }).expect(200);
    });
  });

  // ---------- Search Products ----------
  describe('POST /product/202502/products/search', () => {
    it('returns the OAS envelope with VND prices as strings, SKU-level price and warehouse inventory', async () => {
      const { accessToken } = await connect(0);
      const res = await search(accessToken).expect(200);
      expect(res.body).toMatchObject({ code: 0, message: expect.any(String), request_id: expect.any(String) });
      expect(res.body.data.next_page_token).toBe('');
      expect(res.body.data.total_count).toBe(res.body.data.products.length);
      const tee = res.body.data.products.find((p: any) => p.id === 'sim-product-a-tee');
      expect(tee.status).toBe('ACTIVATE');
      expect(tee.skus).toHaveLength(3);
      const white = tee.skus.find((s: any) => s.seller_sku === 'TEE-WHT-M');
      expect(white.price).toEqual({ currency: 'VND', sale_price: '129000' });
      const black = tee.skus.find((s: any) => s.seller_sku === 'TEE-BLK-M');
      expect(black.price.sale_price).toBe('135000');
      expect(white.inventory).toHaveLength(2);
      expect(white.inventory.every((i: any) => typeof i.warehouse_id === 'string' && /^\d+$/.test(i.warehouse_id) && Number.isInteger(i.quantity))).toBe(true);
      expect(Number.isInteger(tee.create_time)).toBe(true);
    });

    it('lists hidden and deleted products with their status; status filter selects them', async () => {
      const { accessToken } = await connect(0);
      const all = await search(accessToken).expect(200);
      const byId = Object.fromEntries(all.body.data.products.map((p: any) => [p.id, p.status]));
      expect(Object.values(byId)).toEqual(expect.arrayContaining(['ACTIVATE', 'SELLER_DEACTIVATED', 'DELETED']));
      const deleted = await search(accessToken, { page_size: '100' }, { status: 'DELETED' }).expect(200);
      expect(deleted.body.data.products.map((p: any) => p.status)).toEqual(['DELETED']);
      expect(deleted.body.data.total_count).toBe(1);
    });

    it('requires page_size in [1,100] and rejects bad cursors and unsupported filters as invalid_input', async () => {
      const { accessToken } = await connect(0);
      for (const query of [{}, { page_size: '0' }, { page_size: '101' }, { page_size: 'ten' }, { page_size: '10', page_token: 'not-a-token' }]) {
        const r = await search(accessToken, query as any);
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
      for (const body of [{ status: 'WHATEVER' }, { listing_platforms: ['TIKTOK_SHOP'] }, { nope: 1 }, { create_time_ge: 'x' }, { seller_skus: 'A' }]) {
        const r = await search(accessToken, { page_size: '10' }, body);
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
    });

    it('filters by seller_skus, sku_ids and time window', async () => {
      const { accessToken } = await connect(0);
      const bySku = await search(accessToken, { page_size: '100' }, { seller_skus: ['BTL-500-SLV'] }).expect(200);
      expect(bySku.body.data.products.map((p: any) => p.id)).toEqual(['sim-product-a-bottle']);
      const byId = await search(accessToken, { page_size: '100' }, { sku_ids: ['sim-sku-a-BAG-NVY'] }).expect(200);
      expect(byId.body.data.products.map((p: any) => p.id)).toEqual(['sim-product-a-bag']);
      const future = await search(accessToken, { page_size: '100' }, { update_time_ge: Math.floor(Date.now() / 1000) + 3600 }).expect(200);
      expect(future.body.data.products).toEqual([]);
      expect(future.body.data.total_count).toBe(0);
      expect(future.body.data.next_page_token).toBe('');
    });

    it('pages 75 products with an opaque cursor: no skip, no duplicate, last page has an empty token', async () => {
      const { accessToken, seller } = await connect(0);
      await addProducts(seller, 70);
      const { ids, pages } = await crawl(accessToken, 7);
      expect(ids).toHaveLength(new Set(ids).size);
      expect(ids).toHaveLength(await prisma.product.count({ where: { shopId: seller.shopId } }));
      expect(pages).toBeGreaterThan(10);
      const first = await search(accessToken, { page_size: '7' }).expect(200);
      expect(first.body.data.products).toHaveLength(7);
      expect(first.body.data.next_page_token).not.toBe('');
      expect(first.body.data.total_count).toBe(ids.length);
    });

    it('products added between two page requests are returned later, never skipped or repeated', async () => {
      const { accessToken, seller } = await connect(0);
      await addProducts(seller, 20);
      const first = await search(accessToken, { page_size: '10' }).expect(200);
      await addProducts(seller, 5, 'Late');
      const seen = first.body.data.products.map((p: any) => p.id);
      let token = first.body.data.next_page_token;
      while (token) {
        const r = await search(accessToken, { page_size: '10', page_token: token }).expect(200);
        seen.push(...r.body.data.products.map((p: any) => p.id));
        token = r.body.data.next_page_token;
      }
      expect(seen).toHaveLength(new Set(seen).size);
      expect(seen).toHaveLength(await prisma.product.count({ where: { shopId: seller.shopId } }));
    });
  });

  // ---------- Get Product ----------
  describe('GET /product/202309/products/{product_id}', () => {
    it('returns description, images, sales attributes and per-SKU price', async () => {
      const { accessToken } = await connect(0);
      const res = await call('GET', detailPath('sim-product-a-tee'), accessToken).expect(200);
      const d = res.body.data;
      expect(d).toMatchObject({ id: 'sim-product-a-tee', status: 'ACTIVATE', title: expect.any(String), description: expect.any(String) });
      expect(d.main_images[0].urls[0]).toContain('/demo/media/products/');
      const prices = d.skus.map((s: any) => s.price.sale_price).sort();
      expect(prices).toEqual(['129000', '129000', '135000']);
      expect(d.skus[0].sales_attributes[0]).toMatchObject({ name: expect.any(String), value_name: expect.any(String) });
      expect(d.skus[0].status_info.status).toBe('NORMAL');
    });

    it('unknown product, and a product that exists only in another shop, are both product_not_found', async () => {
      const { accessToken } = await connect(0);
      const missing = await call('GET', detailPath('does-not-exist'), accessToken);
      expect(missing.status).toBe(404);
      expect(missing.body.simulator_fault.kind).toBe('product_not_found');
      const other = await call('GET', detailPath('sim-product-b-mug'), accessToken);
      expect(other.status).toBe(404);
    });
  });

  // ---------- Warehouses ----------
  describe('GET /logistics/202309/warehouses', () => {
    it('returns only the warehouses of the token shop; inventory warehouse_id values match them', async () => {
      const a = await connect(0);
      const res = await call('GET', WAREHOUSES, a.accessToken).expect(200);
      const ws = res.body.data.warehouses;
      expect(ws).toHaveLength(2);
      expect(ws.filter((w: any) => w.is_default)).toHaveLength(1);
      expect(ws[0]).toMatchObject({ id: expect.stringMatching(/^\d+$/), name: expect.any(String), effect_status: 'ENABLED', type: 'SALES_WAREHOUSE', sub_type: 'DOMESTIC_WAREHOUSE' });
      const ids = new Set(ws.map((w: any) => w.id));
      const products = (await search(a.accessToken).expect(200)).body.data.products;
      for (const p of products) for (const s of p.skus) for (const i of s.inventory) expect(ids.has(i.warehouse_id)).toBe(true);
      const b = await connect(1);
      const resB = await call('GET', WAREHOUSES, b.accessToken).expect(200);
      const idsB = resB.body.data.warehouses.map((w: any) => w.id);
      expect(idsB.some((id: string) => ids.has(id))).toBe(false);
    });
  });

  // ---------- isolation ----------
  describe('shop isolation', () => {
    it('the same product and SKU id in two shops stay separate on every read', async () => {
      const a = await connect(0);
      const b = await connect(1);
      const pa = await call('GET', detailPath('sim-product-shared-1'), a.accessToken).expect(200);
      const pb = await call('GET', detailPath('sim-product-shared-1'), b.accessToken).expect(200);
      expect(pa.body.data.skus[0].id).toBe('sim-sku-shared-1');
      expect(pb.body.data.skus[0].id).toBe('sim-sku-shared-1');
      expect(pa.body.data.skus[0].price.sale_price).toBe('50000');
      expect(pb.body.data.skus[0].price.sale_price).toBe('75000');
      expect(pa.body.data.title).not.toBe(pb.body.data.title);
      const sa = await search(a.accessToken, { page_size: '100' }, { sku_ids: ['sim-sku-shared-1'] }).expect(200);
      expect(sa.body.data.products[0].title).toBe(pa.body.data.title);
    });

    it('a shop_cipher of another shop is rejected and a cursor from shop A returns shop B data only for B', async () => {
      const a = await connect(0);
      const b = await connect(1);
      const otherCipher = (await prisma.shop.findUniqueOrThrow({ where: { id: b.seller.shopId } })).shopCipher;
      const r = await search(a.accessToken, { page_size: '10', shop_cipher: otherCipher });
      expect(r.status).toBe(403);
      const firstA = await search(a.accessToken, { page_size: '2' }).expect(200);
      const reuse = await search(b.accessToken, { page_size: '100', page_token: firstA.body.data.next_page_token }).expect(200);
      const shopB = await prisma.product.findMany({ where: { shopId: b.seller.shopId }, select: { externalId: true } });
      for (const p of reuse.body.data.products) expect(shopB.map((x) => x.externalId)).toContain(p.id);
    });

    it('duplicate seller SKUs inside one shop are returned as separate SKUs with distinct ids', async () => {
      const b = await connect(1);
      const res = await call('GET', detailPath((await prisma.product.findFirstOrThrow({ where: { shopId: b.seller.shopId, title: { contains: 'trùng seller SKU' } } })).externalId), b.accessToken).expect(200);
      const skus = res.body.data.skus;
      expect(skus.map((s: any) => s.seller_sku)).toEqual(['DUP-1', 'DUP-1']);
      expect(new Set(skus.map((s: any) => s.id)).size).toBe(2);
    });

    it('requires the product scope and a valid signature', async () => {
      const a = await connect(0);
      await prisma.token.updateMany({ data: { scopes: ['sim.authorized_shops.read'] } });
      const r = await search(a.accessToken);
      expect(r.status).toBe(403);
      expect(r.body.simulator_fault.kind).toBe('missing_scope');
      const bad = await call('POST', SEARCH, a.accessToken, { query: { page_size: '1' }, body: {}, secret: 'wrong-secret' });
      expect(bad.status).toBe(401);
    });
  });

  // ---------- Seller / Buyer demo ----------
  describe('/demo catalog', () => {
    it('seller creates a product; Search Products and Get Product show it with independent SKU prices', async () => {
      const { accessToken, seller } = await connect(0);
      const warehouses = (await call('GET', WAREHOUSES, accessToken).expect(200)).body.data.warehouses;
      const created = (
        await http
          .post(`/demo/shops/${seller.shopId}/catalog/products`)
          .set('x-demo-session', seller.token)
          .send({
            title: 'Giày thể thao',
            description: 'Đế cao su',
            skus: [
              { sellerSku: 'SHOE-40', name: '40', attributeName: 'Size', priceVnd: 450000, stock: { [warehouses[0].id]: 12 } },
              { sellerSku: 'SHOE-41', name: '41', attributeName: 'Size', priceVnd: 460000 },
            ],
          })
          .expect(201)
      ).body;
      expect(created.externalId).toMatch(/^\d+$/);
      const [s40, s41] = created.skus;
      await http.patch(`/demo/shops/${seller.shopId}/catalog/skus/${s40.id}`).set('x-demo-session', seller.token).send({ priceVnd: 399000 }).expect(200);
      const detail = (await call('GET', detailPath(created.externalId), accessToken).expect(200)).body.data;
      const price = (sku: string) => detail.skus.find((s: any) => s.seller_sku === sku).price.sale_price;
      expect(price('SHOE-40')).toBe('399000');
      expect(price('SHOE-41')).toBe('460000');
      expect(detail.skus[0].inventory.find((i: any) => i.warehouse_id === warehouses[0].id).quantity).toBe(12);
      await http.patch(`/demo/shops/${seller.shopId}/catalog/skus/${s41.id}`).set('x-demo-session', seller.token).send({ stock: { [warehouses[0].id]: 3 } }).expect(200);
      expect(s41.id).not.toBe(s40.id);
    });

    it('status changes and soft delete show in Search Products; deleted products leave the storefront', async () => {
      const { accessToken, seller } = await connect(0);
      const buyer = await buyerSession(0);
      const product = await prisma.product.findFirstOrThrow({ where: { shopId: seller.shopId, externalId: 'sim-product-a-bag' } });
      const storefrontIds = async () => (await http.get(`/demo/shops/${buyer.shopId}/storefront/products`).set('x-demo-session', buyer.token).expect(200)).body.items.map((p: any) => p.id);
      expect(await storefrontIds()).toContain('sim-product-a-bag');
      await http.patch(`/demo/shops/${seller.shopId}/catalog/products/${product.id}`).set('x-demo-session', seller.token).send({ status: 'SELLER_DEACTIVATED' }).expect(200);
      expect(await storefrontIds()).not.toContain('sim-product-a-bag');
      const hidden = await search(accessToken, { page_size: '100' }, { status: 'SELLER_DEACTIVATED' }).expect(200);
      expect(hidden.body.data.products.map((p: any) => p.id)).toContain('sim-product-a-bag');
      await http.delete(`/demo/shops/${seller.shopId}/catalog/products/${product.id}`).set('x-demo-session', seller.token).expect(200);
      const gone = await call('GET', detailPath('sim-product-a-bag'), accessToken).expect(200);
      expect(gone.body.data.status).toBe('DELETED');
      await http.patch(`/demo/shops/${seller.shopId}/catalog/products/${product.id}`).set('x-demo-session', seller.token).send({ title: 'x' }).expect(400);
    });

    it('a seller session cannot read or change another shop, and a buyer session cannot change the catalog', async () => {
      const a = await sellerSession(0);
      const b = await sellerSession(1);
      await http.get(`/demo/shops/${b.shopId}/catalog`).set('x-demo-session', a.token).expect(403);
      await http.post(`/demo/shops/${b.shopId}/catalog/products`).set('x-demo-session', a.token).send({ title: 't', skus: [{ sellerSku: 's', name: 'n', priceVnd: 1 }] }).expect(403);
      const buyer = await buyerSession(0);
      await http.post(`/demo/shops/${buyer.shopId}/catalog/products`).set('x-demo-session', buyer.token).send({ title: 't', skus: [{ sellerSku: 's', name: 'n', priceVnd: 1 }] }).expect(403);
      const ownProduct = await prisma.product.findFirstOrThrow({ where: { shopId: b.shopId } });
      await http.patch(`/demo/shops/${a.shopId}/catalog/products/${ownProduct.id}`).set('x-demo-session', a.token).send({ title: 'hijack' }).expect(404);
      await http.post(`/demo/shops/${a.shopId}/catalog/products`).set('x-demo-session', a.token).send({ title: 't', skus: [{ sellerSku: 's', name: 'n', priceVnd: 0 }] }).expect(400);
    });

    it('buyer lists active products and opens detail by marketplace product id; SKU price and stock are correct', async () => {
      const buyer = await buyerSession(0);
      const list = (await http.get(`/demo/shops/${buyer.shopId}/storefront/products`).set('x-demo-session', buyer.token).expect(200)).body;
      const ids = list.items.map((p: any) => p.id);
      expect(ids).toContain('sim-product-a-tee');
      expect(ids).not.toContain('sim-product-a-hidden');
      expect(ids).not.toContain('sim-product-a-deleted');
      const tee = list.items.find((p: any) => p.id === 'sim-product-a-tee');
      expect(tee.minPriceVnd).toBe(129000);
      expect(tee.maxPriceVnd).toBe(135000);
      const detail = (await http.get(`/demo/shops/${buyer.shopId}/storefront/products/sim-product-a-tee`).set('x-demo-session', buyer.token).expect(200)).body.product;
      const black = detail.skus.find((s: any) => s.id === 'sim-sku-a-TEE-BLK-M');
      expect(black).toMatchObject({ priceVnd: 135000, available: true, stock: 50 });
      await http.get(`/demo/shops/${buyer.shopId}/storefront/products/sim-product-a-hidden`).set('x-demo-session', buyer.token).expect(404);
      const otherShop = await sellerSession(1);
      await http.get(`/demo/shops/${otherShop.shopId}/storefront/products`).set('x-demo-session', buyer.token).expect(200);
    });

    it('serves a placeholder image without a session and rejects non-uuid names', async () => {
      const p = await prisma.product.findFirstOrThrow();
      const img = await http.get(`/demo/media/products/${p.id}.svg`).expect(200);
      expect(img.headers['content-type']).toContain('image/svg+xml');
      await http.get('/demo/media/products/..%2Fsecret').expect(404);
    });
  });

  it('keeps TikTok-shaped catalog reads off /demo and /test-admin (no leakage of demo paths into the TikTok router)', async () => {
    await http.get('/demo/product/202502/products/search').expect(404);
    await http.post('/product/202502/products').send({}).expect(404);
  });
});

describe('Phase 04: test-admin bulk catalog', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  it('requires the admin token, creates the requested products with unique ids, and is not reachable from the TikTok router', async () => {
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
    const http = request(app.getHttpServer());
    const shop = await prisma.shop.findFirstOrThrow();
    await http.post('/test-admin/catalog/bulk').send({ shopId: shop.id, count: 3 }).expect(401);
    const before = await prisma.product.count({ where: { shopId: shop.id } });
    const res = await http.post('/test-admin/catalog/bulk').set('x-test-admin-token', 'test-admin-token-1234').send({ shopId: shop.id, count: 12, skusPerProduct: 3 }).expect(201);
    expect(res.body.totalProducts).toBe(before + 12);
    const skus = await prisma.sku.findMany({ where: { shopId: shop.id, sellerSku: { startsWith: 'BULK-' } } });
    expect(skus).toHaveLength(36);
    expect(new Set(skus.map((s) => s.externalId)).size).toBe(36);
    await http.post('/test-admin/catalog/bulk').set('x-test-admin-token', 'test-admin-token-1234').send({ shopId: shop.id, count: 501 }).expect(400);
    await http.post('/catalog/bulk').send({ shopId: shop.id, count: 1 }).expect(404);
  });
});
