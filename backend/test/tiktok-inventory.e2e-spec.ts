import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { conformErrors } from './contract';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const updatePath = (productId: string) => `/product/202309/products/${productId}/inventory/update`;
const PRODUCT_TEE = 'sim-product-a-tee';
const WHITE_M = 'sim-sku-a-TEE-WHT-M'; // seeded 40 (HN) / 25 (HCM)
const WHITE_L = 'sim-sku-a-TEE-WHT-L'; // 30 / 20
const BAG_NAT = 'sim-sku-a-BAG-NAT';

describe('Phase 06: Update Inventory (absolute quantities), faults, change log', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let t: TiktokTestClient;
  let http: ReturnType<typeof request>;
  let shopAId: string;
  let hn: string; // external warehouse ids of shop A
  let hcm: string;
  let shopBId: string;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    http = request(app.getHttpServer());
    t = new TiktokTestClient(http, cfg);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
    shopBId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Gốm' } } })).id;
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
    const ws = await prisma.warehouse.findMany({ where: { shopId: shopAId }, orderBy: { code: 'asc' } });
    hcm = ws.find((w) => w.code === 'WH-HCM')!.externalId;
    hn = ws.find((w) => w.code === 'WH-HN')!.externalId;
  });

  const qty = async (skuExternalId: string, warehouseExternalId: string, shopId = shopAId) =>
    (await prisma.inventoryLevel.findFirstOrThrow({ where: { sku: { externalId: skuExternalId, shopId }, warehouse: { externalId: warehouseExternalId } } })).quantity;
  const update = (token: string, productId: string, skus: unknown, extra: { secret?: string } = {}) => t.call('POST', updatePath(productId), token, { body: { skus }, ...extra });
  const body = (id: string, h: number, c: number) => [{ id, inventory: [{ warehouse_id: hn, quantity: h }, { warehouse_id: hcm, quantity: c }] }];
  const createFault = (kind: string, params: object = { delayMs: 0 }, remaining: number | null = 1) =>
    http.post('/test-admin/faults').set(admin).send({ shopId: shopAId, target: 'API', kind, pathMatch: '/product/202309/products/', remaining, params }).expect(201);

  describe('inventory webhook', () => {
    it('queues one post-change snapshot for a changed SKU and none for an absolute retry', async () => {
      const { accessToken } = await t.connect(0);
      const appRow = await prisma.app.findFirstOrThrow();
      await prisma.webhookSubscription.create({ data: { shopId: shopAId, appId: appRow.id, eventType: 'INVENTORY_CHANGED_BY_SHOP', address: 'https://example.test/webhooks', createdAt: new Date(), updatedAt: new Date() } });
      await update(accessToken, PRODUCT_TEE, body(WHITE_M, 0, 25)).expect(200);
      await update(accessToken, PRODUCT_TEE, body(WHITE_M, 0, 25)).expect(200);
      const jobs = await prisma.webhookJob.findMany({ where: { shopId: shopAId, topic: 'INVENTORY_CHANGED_BY_SHOP' } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({ type: 71, data: { product_id: PRODUCT_TEE, sku_id: WHITE_M, quantity_snapshot_after_change: { available_quantity: 25, warehouses: expect.arrayContaining([{ warehouse_id: hn, available_quantity: 0 }, { warehouse_id: hcm, available_quantity: 25 }]) } } });
    });
  });

  describe('absolute update', () => {
    it('accepts zero in every warehouse and a repeated absolute update stays zero', async () => {
      const { accessToken } = await t.connect(0);
      const zero = body(WHITE_M, 0, 0);
      expect((await update(accessToken, PRODUCT_TEE, zero).expect(200)).body.data.errors).toEqual([]);
      expect((await update(accessToken, PRODUCT_TEE, zero).expect(200)).body.data.errors).toEqual([]);
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([0, 0]);
    });
    it('replaces the quantities; repeating the same request leaves the same state (a safe retry) and the log marks it as a no-op', async () => {
      const { accessToken } = await t.connect(0);
      const first = await update(accessToken, PRODUCT_TEE, body(WHITE_M, 12, 7)).expect(200);
      expect(first.body).toMatchObject({ code: 0, data: { errors: [] } });
      expect(conformErrors('ops/product.inventory_update.response.json', first.body)).toEqual([]);
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([12, 7]);
      const again = await update(accessToken, PRODUCT_TEE, body(WHITE_M, 12, 7)).expect(200);
      expect(again.body.data.errors).toEqual([]);
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([12, 7]); // not 12 - 12 or 24
      const log = await prisma.inventoryChange.findMany({ where: { source: 'API' }, orderBy: { seq: 'asc' } });
      expect(log.map((l) => [l.before, l.after, l.noop])).toEqual([[40, 12, false], [25, 7, false], [12, 12, true], [7, 7, true]]);
      expect(log.every((l) => l.requestId)).toBe(true);
      const attempts = await prisma.inventoryUpdateAttempt.findMany({ orderBy: { seq: 'asc' } });
      expect(attempts.map((a) => a.outcome)).toEqual(['APPLIED', 'APPLIED']);
    });

    it('does not accept a decrement-style input: the stored value is replaced, never subtracted', async () => {
      const { accessToken } = await t.connect(0);
      await update(accessToken, PRODUCT_TEE, body(WHITE_L, 5, 5)).expect(200);
      await update(accessToken, PRODUCT_TEE, body(WHITE_L, 90, 80)).expect(200);
      expect([await qty(WHITE_L, hn), await qty(WHITE_L, hcm)]).toEqual([90, 80]);
    });

    it('a single-warehouse SKU may omit warehouse_id; a multi-warehouse SKU may not', async () => {
      const { accessToken, seller } = await t.connect(0);
      const noWarehouse = await update(accessToken, PRODUCT_TEE, [{ id: WHITE_M, inventory: [{ quantity: 5 }] }]).expect(200);
      expect(noWarehouse.body.data.errors).toHaveLength(1);
      expect(await qty(WHITE_M, hn)).toBe(40);
      // a shop with one warehouse
      const sellerB = await t.connect(1);
      const wsB = await prisma.warehouse.findMany({ where: { shop: { name: { contains: 'Gốm' } } } });
      expect(wsB).toHaveLength(2);
      expect(seller.shopId).toBe(shopAId);
      await prisma.inventoryLevel.deleteMany({ where: { warehouseId: wsB[1].id } });
      const single = await t.call('POST', updatePath('sim-product-b-vase'), sellerB.accessToken, { body: { skus: [{ id: 'sim-sku-b-VASE-25', inventory: [{ quantity: 9 }] }] } }).expect(200);
      expect(single.body.data.errors).toEqual([]);
      expect((await prisma.inventoryLevel.findFirstOrThrow({ where: { warehouseId: wsB[0].id, sku: { externalId: 'sim-sku-b-VASE-25' } } })).quantity).toBe(9);
    });
  });

  describe('validation and partial failure', () => {
    it('reports per-SKU errors with per-warehouse extra errors and applies nothing for a failing SKU; valid SKUs in the same request are applied (PARTIAL)', async () => {
      const { accessToken } = await t.connect(0);
      const res = await update(accessToken, PRODUCT_TEE, [
        ...body(WHITE_M, 11, 22),
        { id: WHITE_L, inventory: [{ warehouse_id: hn, quantity: 100000 }, { warehouse_id: hcm, quantity: 3 }] },
      ]).expect(200);
      expect(conformErrors('ops/product.inventory_update.response.json', res.body)).toEqual([]);
      expect(res.body.data.errors).toHaveLength(1);
      const err = res.body.data.errors[0];
      expect(err).toMatchObject({ code: expect.any(Number), message: expect.any(String), detail: { sku_id: WHITE_L, extra_errors: [{ warehouse_id: hn, message: expect.stringContaining('[0, 99999]') }] } });
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([11, 22]); // valid SKU applied
      expect([await qty(WHITE_L, hn), await qty(WHITE_L, hcm)]).toEqual([30, 20]); // failing SKU untouched: even its valid warehouse (3) was not written
      expect((await prisma.inventoryUpdateAttempt.findFirstOrThrow()).outcome).toBe('PARTIAL');
    });

    it('rejects negative, fractional and string quantities; missing, repeated and foreign warehouses; and changes nothing', async () => {
      const { accessToken } = await t.connect(0);
      const sellerB = await prisma.warehouse.findFirstOrThrow({ where: { shop: { name: { contains: 'Gốm' } } } });
      const bad = [
        [{ warehouse_id: hn, quantity: -4 }, { warehouse_id: hcm, quantity: 3 }],
        [{ warehouse_id: hn, quantity: 1.5 }, { warehouse_id: hcm, quantity: 3 }],
        [{ warehouse_id: hn, quantity: '5' }, { warehouse_id: hcm, quantity: 3 }],
        [{ warehouse_id: hn, quantity: 5 }], // hcm omitted
        [{ warehouse_id: hn, quantity: 5 }, { warehouse_id: hn, quantity: 6 }, { warehouse_id: hcm, quantity: 3 }], // repeated
        [{ warehouse_id: hn, quantity: 5 }, { warehouse_id: hcm, quantity: 3 }, { warehouse_id: sellerB.externalId, quantity: 3 }], // other shop's warehouse
      ];
      for (const inventory of bad) {
        const r = await update(accessToken, PRODUCT_TEE, [{ id: WHITE_M, inventory }]).expect(200);
        expect(r.body.data.errors).toHaveLength(1);
        expect(r.body.data.errors[0].detail.extra_errors.length).toBeGreaterThan(0);
      }
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([40, 25]);
      expect(await prisma.inventoryChange.count({ where: { source: 'API' } })).toBe(0);
    });

    it('envelope-level invalid input (not an object, no skus, wrong types) is a 400 invalid_input', async () => {
      const { accessToken } = await t.connect(0);
      for (const b of [[], { skus: [] }, { skus: 'x' }, { skus: [{ id: 5, inventory: [] }] }, { skus: [{ id: WHITE_M }] }, { skus: [{ id: WHITE_M, inventory: [{ warehouse_id: 7, quantity: 1 }] }] }]) {
        const r = await t.call('POST', updatePath(PRODUCT_TEE), accessToken, { body: b });
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
      expect(await qty(WHITE_M, hn)).toBe(40);
    });

    it('a SKU of another product of the same shop is rejected per SKU; FREEZE/DELETED products cannot be updated', async () => {
      const { accessToken } = await t.connect(0);
      const r = await update(accessToken, PRODUCT_TEE, [{ id: BAG_NAT, inventory: [{ warehouse_id: hn, quantity: 5 }, { warehouse_id: hcm, quantity: 5 }] }]).expect(200);
      expect(r.body.data.errors[0].detail.sku_id).toBe(BAG_NAT);
      expect(await qty(BAG_NAT, hn)).toBe(50);
      const del = await update(accessToken, 'sim-product-a-deleted', [{ id: 'sim-sku-a-CASE-OLD', inventory: [{ warehouse_id: hn, quantity: 5 }, { warehouse_id: hcm, quantity: 5 }] }]).expect(200);
      expect(del.body.data.errors[0].message).toContain('DELETED');
      await prisma.product.updateMany({ where: { shopId: shopAId, externalId: PRODUCT_TEE }, data: { status: 'FREEZE' } });
      const frozen = await update(accessToken, PRODUCT_TEE, body(WHITE_M, 1, 1)).expect(200);
      expect(frozen.body.data.errors[0].message).toContain('FREEZE');
      expect(await qty(WHITE_M, hn)).toBe(40);
    });

    it('a duplicate SKU in one request applies only the first occurrence', async () => {
      const { accessToken } = await t.connect(0);
      const r = await update(accessToken, PRODUCT_TEE, [...body(WHITE_M, 10, 10), ...body(WHITE_M, 99, 99)]).expect(200);
      expect(r.body.data.errors).toHaveLength(1);
      expect(await qty(WHITE_M, hn)).toBe(10);
    });
  });

  describe('shop isolation, scope, signature', () => {
    it('ids of another shop are unknown: no data is read or changed across shops, even when ids coincide', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const sharedA = await qty('sim-sku-shared-1', hn);
      const wsB = await prisma.warehouse.findMany({ where: { shop: { name: { contains: 'Gốm' } } }, orderBy: { code: 'asc' } });
      const sharedBBefore = await prisma.inventoryLevel.findMany({ where: { sku: { externalId: 'sim-sku-shared-1', shopId: shopBId } }, orderBy: { id: 'asc' } });
      // A's token naming B's product id → unknown product
      const cross = await update(a.accessToken, 'sim-product-b-mug', [{ id: 'sim-sku-b-MUG-BLU', inventory: [{ warehouse_id: wsB[0].externalId, quantity: 1 }, { warehouse_id: wsB[1].externalId, quantity: 1 }] }]);
      expect(cross.status).toBe(404);
      expect(cross.body.simulator_fault.kind).toBe('product_not_found');
      // identical product + SKU ids in both shops: updating through A changes only A
      await update(a.accessToken, 'sim-product-shared-1', [{ id: 'sim-sku-shared-1', inventory: [{ warehouse_id: hn, quantity: 77 }, { warehouse_id: hcm, quantity: 66 }] }]).expect(200);
      expect(await qty('sim-sku-shared-1', hn)).toBe(77);
      expect(sharedA).not.toBe(77);
      const sharedBAfter = await prisma.inventoryLevel.findMany({ where: { sku: { externalId: 'sim-sku-shared-1', shopId: shopBId } }, orderBy: { id: 'asc' } });
      expect(sharedBAfter.map((l) => l.quantity)).toEqual(sharedBBefore.map((l) => l.quantity));
      void b;
    });

    it('needs the inventory scope and a valid signature', async () => {
      const a = await t.connect(0);
      const bad = await update(a.accessToken, PRODUCT_TEE, body(WHITE_M, 1, 1), { secret: 'wrong' });
      expect(bad.status).toBe(401);
      await prisma.token.updateMany({ data: { scopes: ['sim.product.read'] } });
      const r = await update(a.accessToken, PRODUCT_TEE, body(WHITE_M, 1, 1));
      expect(r.status).toBe(403);
      expect(r.body.simulator_fault.kind).toBe('missing_scope');
      expect(await qty(WHITE_M, hn)).toBe(40);
    });
  });

  describe('fault injection (timeouts and HTTP 200 application errors)', () => {
    it('TIMEOUT_AFTER_WRITE: the caller gets no answer but the write is committed; the retry is a harmless no-op', async () => {
      const { accessToken } = await t.connect(0);
      await createFault('TIMEOUT_AFTER_WRITE');
      await expect(update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44))).rejects.toThrow();
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([33, 44]);
      const retry = await update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44)).expect(200); // fault was single-use
      expect(retry.body.data.errors).toEqual([]);
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([33, 44]);
      const attempts = await prisma.inventoryUpdateAttempt.findMany({ orderBy: { seq: 'asc' } });
      expect(attempts.map((a) => a.outcome)).toEqual(['TIMEOUT_AFTER_WRITE', 'APPLIED']);
      expect((await prisma.inventoryChange.findMany({ where: { source: 'API' }, orderBy: { seq: 'asc' } })).map((c) => c.noop)).toEqual([false, false, true, true]);
    });

    it('TIMEOUT_BEFORE_WRITE: no answer and nothing written; the retry applies the value once', async () => {
      const { accessToken } = await t.connect(0);
      await createFault('TIMEOUT_BEFORE_WRITE');
      await expect(update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44))).rejects.toThrow();
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([40, 25]);
      expect(await prisma.inventoryChange.count({ where: { source: 'API' } })).toBe(0);
      await update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44)).expect(200);
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([33, 44]);
      expect((await prisma.inventoryUpdateAttempt.findMany({ orderBy: { seq: 'asc' } })).map((a) => a.outcome)).toEqual(['TIMEOUT_BEFORE_WRITE', 'APPLIED']);
    });

    it('APP_ERROR_200: HTTP 200 with a non-zero code, nothing written (a client must not treat this as success)', async () => {
      const { accessToken } = await t.connect(0);
      await createFault('APP_ERROR_200');
      const r = await update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44));
      expect(r.status).toBe(200);
      expect(r.body.code).not.toBe(0);
      expect(r.body.simulator_fault.kind).toBe('app_error_200');
      expect(r.body.data).toEqual({});
      expect([await qty(WHITE_M, hn), await qty(WHITE_M, hcm)]).toEqual([40, 25]);
      expect((await update(accessToken, PRODUCT_TEE, body(WHITE_M, 33, 44)).expect(200)).body.code).toBe(0);
    });

    it('inventory faults are not consumed by other API paths or by the webhook worker', async () => {
      const { accessToken } = await t.connect(0);
      await createFault('APP_ERROR_200', {}, 1);
      await t.call('POST', '/product/202502/products/search', accessToken, { query: { page_size: '5' }, body: {} }).expect(200);
      await t.call('GET', '/logistics/202309/warehouses', accessToken).expect(200);
      expect((await prisma.faultRule.findFirstOrThrow()).remaining).toBe(1);
    });

    it('the Test Console accepts the new fault kinds and rejects unknown kinds', async () => {
      await http.post('/test-admin/faults').set(admin).send({ target: 'API', kind: 'NOPE' }).expect(400);
      await createFault('TIMEOUT_BEFORE_WRITE');
    });
  });

  describe('concurrency and the change log', () => {
    it('concurrent absolute updates and checkouts never go negative or lose an update: the per-row log is an unbroken before/after chain', async () => {
      const { accessToken } = await t.connect(0);
      const buyers = await Promise.all([0, 1, 2].map((i) => t.buyerSession(0, i)));
      const checkouts = Array.from({ length: 9 }, (_, i) => t.checkout(buyers[i % 3], [{ skuId: WHITE_M, quantity: 1 }], `inv-race-key-${i}`));
      const updates = Array.from({ length: 6 }, (_, i) => update(accessToken, PRODUCT_TEE, body(WHITE_M, 20 + i, 15 + i)));
      const results = await Promise.all([...checkouts, ...updates]);
      for (const r of results.slice(9)) expect(r.status).toBe(200);
      const orderIds = results.slice(0, 9).filter((r) => r.status === 201).map((r) => r.body.order.id as string);
      // cancel two orders: stock is restored exactly once each
      for (const id of orderIds.slice(0, 2)) {
        const row = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
        await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'CANCELLED', shopId: row.shopId }).expect(201);
        await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'CANCELLED', shopId: row.shopId }).expect(400);
      }
      for (const w of [hn, hcm]) {
        const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { sku: { externalId: WHITE_M, shopId: shopAId }, warehouse: { externalId: w } } });
        expect(level.quantity).toBeGreaterThanOrEqual(0);
        const chain = await prisma.inventoryChange.findMany({ where: { skuId: level.skuId, warehouseId: level.warehouseId }, orderBy: { seq: 'asc' } });
        expect(chain.length).toBeGreaterThan(0);
        expect(chain[0].before).toBe(w === hn ? 40 : 25);
        for (let i = 1; i < chain.length; i++) expect(chain[i].before).toBe(chain[i - 1].after); // a lost update would break the chain
        expect(chain[chain.length - 1].after).toBe(level.quantity);
      }
      const sources = new Set((await prisma.inventoryChange.findMany({ select: { source: true } })).map((c) => c.source));
      expect(sources).toEqual(new Set(['API', 'ORDER']));
    });

    it('checkouts racing for the last units never oversell while an update sets the same stock', async () => {
      const { accessToken } = await t.connect(0);
      await update(accessToken, PRODUCT_TEE, body(WHITE_M, 3, 1)).expect(200);
      const buyers = await Promise.all([0, 1, 2].map((i) => t.buyerSession(0, i)));
      const res = await Promise.all(Array.from({ length: 6 }, (_, i) => t.checkout(buyers[i % 3], [{ skuId: WHITE_M, quantity: 1 }], `inv-last-key-${i}`)));
      const ok = res.filter((r) => r.status === 201).length;
      expect(ok).toBeLessThanOrEqual(4); // 3 + 1 units existed in total; one warehouse must hold the whole order
      expect(await qty(WHITE_M, hn)).toBeGreaterThanOrEqual(0);
      expect(await qty(WHITE_M, hcm)).toBeGreaterThanOrEqual(0);
    });

    it('a Seller stock edit is logged as SELLER with before/after, and the seller sees the history; other roles and shops do not', async () => {
      const seller = await t.sellerSession(0);
      const product = await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: PRODUCT_TEE }, include: { skus: true } });
      const sku = product.skus.find((s) => s.externalId === WHITE_M)!;
      await http.patch(`/demo/shops/${seller.shopId}/catalog/skus/${sku.id}`).set('x-demo-session', seller.token).send({ stock: { [hn]: 8 } }).expect(200);
      const hist = (await http.get(`/demo/shops/${seller.shopId}/inventory/history`).set('x-demo-session', seller.token).expect(200)).body;
      expect(hist.changes[0]).toMatchObject({ sku: WHITE_M, warehouse: hn, before: 40, after: 8, source: 'SELLER' });
      const buyer = await t.buyerSession(0);
      await http.get(`/demo/shops/${buyer.shopId}/inventory/history`).set('x-demo-session', buyer.token).expect(403);
      const other = await t.sellerSession(1);
      await http.get(`/demo/shops/${seller.shopId}/inventory/history`).set('x-demo-session', other.token).expect(403);
      await http.get(`/test-admin/inventory/history?shopId=${shopAId}`).expect(401);
      const adminHist = (await http.get(`/test-admin/inventory/history?shopId=${shopAId}`).set(admin).expect(200)).body;
      expect(adminHist.changes.length).toBe(1);
    });

    it('stock set through the API is what the Buyer can purchase', async () => {
      const { accessToken } = await t.connect(0);
      await update(accessToken, PRODUCT_TEE, body(WHITE_L, 1, 1)).expect(200);
      const buyer = await t.buyerSession(0);
      const ok = await t.checkout(buyer, [{ skuId: WHITE_L, quantity: 1 }], 'inv-buy-key-01');
      expect(ok.status).toBe(201);
      const tooMany = await t.checkout(buyer, [{ skuId: WHITE_L, quantity: 2 }], 'inv-buy-key-02');
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.code).toBe('insufficient_stock');
    });
  });
});
