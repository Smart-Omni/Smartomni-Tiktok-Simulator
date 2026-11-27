import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const BAG = 'sim-sku-a-BAG-NAT'; // 99000

describe('OAS alignment P1: Update Price, Inventory Search, Delete / Recover Products', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let t: TiktokTestClient;
  let token: string;
  let shopAId: string;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    t = new TiktokTestClient(request(app.getHttpServer()), cfg);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
    token = (await t.connect(0)).accessToken;
  });

  const productOfBag = async () => {
    const sku = await prisma.sku.findFirstOrThrow({ where: { shopId: shopAId, externalId: BAG }, include: { product: true } });
    return { sku, product: sku.product };
  };
  const create = async (extra: Record<string, unknown> = {}) =>
    (await t.call('POST', '/product/202309/products', token, { body: { title: 'Mới', skus: [{ seller_sku: 'NEW-1', price: { amount: '1000', currency: 'VND' } }], ...extra } }).expect(200)).body.data.product_id as string;

  describe('Create Product stock', () => {
    const send = (inventory: unknown) =>
      t.call('POST', '/product/202309/products', token, { body: { title: 'Tồn', skus: [{ seller_sku: 'STK-1', price: { amount: '1000', currency: 'VND' }, ...(inventory === undefined ? {} : { inventory }) }] } });
    const warehouseOf = async (shop: string) => (await prisma.warehouse.findFirstOrThrow({ where: { shop: { name: { contains: shop } } } })).externalId;

    it('stores the sent quantity in the shop warehouse; omitted inventory means 0 in the default one', async () => {
      const wh = await warehouseOf('Mộc Lan');
      for (const [inventory, quantity] of [
        [[{ warehouse_id: wh, quantity: 0 }], 0],
        [[{ warehouse_id: wh, quantity: 99_999 }], 99_999],
        [[{ quantity: 7 }], 7],
        [undefined, 0],
      ] as const) {
        const r = await send(inventory).expect(200);
        const detail = await t.call('GET', `/product/202309/products/${r.body.data.product_id}`, token).expect(200);
        expect(detail.body.data.skus[0].inventory).toEqual([{ warehouse_id: wh, quantity }]);
      }
    });

    it('rejects unknown or foreign warehouses, repeats and bad quantities, creating nothing', async () => {
      const wh = await warehouseOf('Mộc Lan');
      const foreign = await warehouseOf('Gốm');
      const before = await prisma.product.count();
      for (const inventory of [
        [{ warehouse_id: '7600000000000000000', quantity: 5 }],
        [{ warehouse_id: foreign, quantity: 5 }],
        [{ warehouse_id: wh, quantity: -5 }],
        [{ warehouse_id: wh, quantity: 100_000 }],
        [{ warehouse_id: wh, quantity: 1.5 }],
        [{ warehouse_id: wh, quantity: '5' }],
        [{ warehouse_id: wh }],
        [{ warehouse_id: wh, quantity: 1 }, { warehouse_id: wh, quantity: 2 }],
        [{ warehouse_id: wh, quantity: 1 }, { quantity: 2 }],
        [],
        'x',
        [null],
      ]) {
        const r = await send(inventory);
        expect([inventory, r.status, r.body.simulator_fault?.kind]).toEqual([inventory, 400, 'invalid_input']);
      }
      expect(await prisma.product.count()).toBe(before);
    });
  });

  describe('Update Price', () => {
    const upd = (pid: string, body: unknown, tok = token) => t.call('POST', `/product/202309/products/${pid}/prices/update`, tok, { body });

    it('updates prices atomically, leaves existing orders alone and rejects bad input', async () => {
      const { sku, product } = await productOfBag();
      const buyer = await t.buyerSession(0);
      const order = (await t.checkout(buyer, [{ skuId: BAG, quantity: 1 }], 'key-price-01').expect(201)).body.order;
      await upd(product.externalId, { skus: [{ id: BAG, price: { amount: '123000', currency: 'VND' } }] }).expect(200);
      expect((await prisma.sku.findUniqueOrThrow({ where: { id: sku.id } })).priceVnd).toBe(123000);
      expect((await prisma.orderLine.findFirstOrThrow({ where: { order: { externalId: order.id } } })).salePrice).toBe(99000);
      const others = await prisma.sku.findMany({ where: { productId: product.id, NOT: { id: sku.id } } });
      const mixed = [{ id: BAG, price: { amount: '5', currency: 'VND' } }, { id: 'nope', price: { amount: '5', currency: 'VND' } }];
      await upd(product.externalId, { skus: mixed }).expect(400);
      expect((await prisma.sku.findUniqueOrThrow({ where: { id: sku.id } })).priceVnd).toBe(123000); // nothing written
      for (const price of [{ amount: '5', currency: 'USD' }, { amount: '0', currency: 'VND' }, { amount: '1.5', currency: 'VND' }]) {
        await upd(product.externalId, { skus: [{ id: BAG, price }] }).expect(400);
      }
      await upd(product.externalId, { skus: [] }).expect(400);
      await upd('1', { skus: [{ id: BAG, price: { amount: '5', currency: 'VND' } }] }).expect(404);
      expect(others.length).toBeGreaterThanOrEqual(0);
    });

    it('needs an ACTIVATE product and the right token', async () => {
      const { product } = await productOfBag();
      await prisma.product.update({ where: { id: product.id }, data: { status: 'SELLER_DEACTIVATED' } });
      await upd(product.externalId, { skus: [{ id: BAG, price: { amount: '5', currency: 'VND' } }] }).expect(400);
      await upd(product.externalId, { skus: [] }, 'bad-token').expect((r) => {
        if (r.status < 400) throw new Error(`expected an error, got ${r.status}`);
      });
    });
  });

  describe('Inventory Search', () => {
    const search = (body: unknown) => t.call('POST', '/product/202309/inventory/search', token, { body });

    it('returns totals per SKU and warehouse, counts open orders as committed, and prefers sku_ids', async () => {
      const { product } = await productOfBag();
      const before = await search({ product_ids: [product.externalId] }).expect(200);
      const entry = before.body.data.inventory[0];
      expect(entry.product_id).toBe(product.externalId);
      const sku = entry.skus.find((s: any) => s.id === BAG);
      expect(sku.total_available_quantity).toBe(sku.warehouse_inventory.reduce((n: number, w: any) => n + w.available_quantity, 0));
      expect(sku.total_committed_quantity).toBe(0);
      expect(sku.total_available_inventory_distribution.in_shop_inventory.quantity).toBe(sku.total_available_quantity);
      const buyer = await t.buyerSession(0);
      await t.checkout(buyer, [{ skuId: BAG, quantity: 2 }], 'key-inv-0001').expect(201);
      const after = (await search({ sku_ids: [BAG], product_ids: ['unrelated'] }).expect(200)).body.data.inventory[0].skus[0];
      expect(after.total_committed_quantity).toBe(2);
      expect(after.total_available_quantity).toBe(sku.total_available_quantity - 2);
      expect(after.warehouse_inventory.reduce((n: number, w: any) => n + w.committed_quantity, 0)).toBe(2);
    });

    it('ignores ids of another shop and validates the request', async () => {
      const other = await prisma.sku.findFirstOrThrow({ where: { NOT: { shopId: shopAId } }, include: { product: true } });
      const r = await search({ product_ids: [other.product.externalId], sku_ids: undefined }).expect(200);
      expect(r.body.data.inventory).toEqual([]);
      const bySku = await search({ sku_ids: [other.externalId] }).expect(200);
      expect(bySku.body.data.inventory).toEqual([]);
      await search({}).expect(400);
      await search({ product_ids: Array.from({ length: 101 }, (_, i) => String(i)) }).expect(400);
      await search({ sku_ids: [] }).expect(400);
    });
  });

  describe('Delete / Recover Products', () => {
    const del = (ids: string[]) => t.call('DELETE', '/product/202309/products', token, { body: { product_ids: ids } });
    const rec = (ids: string[]) => t.call('POST', '/product/202309/products/recover', token, { body: { product_ids: ids } });

    it('soft-deletes, reports per-id errors, empties carts and recovers to SELLER_DEACTIVATED', async () => {
      const a = await create();
      const b = await create();
      await prisma.product.update({ where: { shopId_externalId: { shopId: shopAId, externalId: b } }, data: { status: 'FREEZE' } });
      const r = await del([a, b, 'nope']).expect(200);
      expect(r.body.data.errors.map((e: any) => e.detail.product_id).sort()).toEqual([b, 'nope'].sort());
      expect((await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: a } })).status).toBe('DELETED');
      expect((await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: b } })).status).toBe('FREEZE');
      const again = await del([a]).expect(200);
      expect(again.body.data.errors).toEqual([]); // idempotent
      const rr = await rec([a, b]).expect(200);
      expect(rr.body.data.errors.map((e: any) => e.detail.product_id)).toEqual([b]);
      expect((await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: a } })).status).toBe('SELLER_DEACTIVATED');
    });

    it('a deleted product stays visible to Search Products as DELETED and its cart rows go away', async () => {
      const { product, sku } = await productOfBag();
      const buyer = await t.buyerSession(0);
      await prisma.cartItem.create({ data: { buyerId: buyer.buyerId, skuId: sku.id, quantity: 1 } });
      await del([product.externalId]).expect(200);
      expect(await prisma.cartItem.count({ where: { skuId: sku.id } })).toBe(0);
      const found = await t.call('POST', '/product/202502/products/search', token, { query: { page_size: '100' }, body: { status: 'DELETED' } }).expect(200);
      expect(found.body.data.products.map((p: any) => p.id)).toContain(product.externalId);
    });

    it('validates product_ids (1-20 strings)', async () => {
      await del([]).expect(400);
      await rec(Array.from({ length: 21 }, (_, i) => String(i))).expect(400);
    });
  });
});
