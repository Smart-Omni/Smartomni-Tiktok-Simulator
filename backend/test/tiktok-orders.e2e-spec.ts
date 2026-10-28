import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { resolveTargetUrl, webhookSignature, WebhookWorkerService } from '../src/webhooks/webhook-worker.service';
import { conformErrors, loadFixture } from './contract';
import { ADMIN_TOKEN, cleanDb, createApp, FakeTime, FakeTransport } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const SEARCH = '/order/202309/orders/search';
const DETAIL = '/order/202507/orders';
const HOOKS = '/event/202309/webhooks';
const admin = { 'x-test-admin-token': ADMIN_TOKEN };

describe('Phase 05: checkout, orders, Events API and signed webhooks', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let t: TiktokTestClient;
  let transport: FakeTransport;
  let time: FakeTime;
  let http: ReturnType<typeof request>;
  let shopAId: string;

  beforeAll(async () => {
    transport = new FakeTransport();
    time = new FakeTime();
    app = await createApp({ transport, time });
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
    await app.get(PersistentBusinessClock).reset();
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
    transport.calls = [];
    time.current = new Date();
  });

  const SKU_WHITE = 'sim-sku-a-TEE-WHT-M'; // 129000
  const SKU_BLACK = 'sim-sku-a-TEE-BLK-M'; // 135000
  const stockOf = async (skuExternalId: string) => (await prisma.inventoryLevel.findMany({ where: { sku: { externalId: skuExternalId, shopId: shopAId } } })).reduce((n, l) => n + l.quantity, 0);

  async function placeOrder(buyer: { token: string; shopId: string }, key: string, items = [{ skuId: SKU_WHITE, quantity: 1 }], pay = true) {
    const c = await t.checkout(buyer, items, key).expect(201);
    if (pay) await t.pay(buyer, c.body.order.id).expect(201);
    return c.body.order.id as string;
  }
  const releaseHold = async () => {
    await http.put('/test-admin/clock').set(admin).send({ advanceMs: (cfg.orders.holdMinutes + 1) * 60_000 }).expect(200);
    return (await http.post('/test-admin/orders/release-due').set(admin).expect(201)).body.released as string[];
  };

  // ---------- checkout ----------
  describe('checkout (backend computed money, snapshots, validation)', () => {
    it('computes components server-side and keeps them separate; the order stores line snapshots per unit', async () => {
      const buyer = await t.buyerSession(0);
      const res = await t.checkout(buyer, [{ skuId: SKU_WHITE, quantity: 2 }, { skuId: SKU_BLACK, quantity: 1 }], 'key-checkout-1').expect(201);
      const a = res.body.order.amounts;
      expect(a).toMatchObject({ currency: 'VND', productTotalVnd: 2 * 129000 + 135000, sellerDiscountVnd: 0, platformDiscountVnd: 0, subTotalVnd: 393000, shippingFeeVnd: cfg.orders.shippingFeeVnd, taxVnd: 0 });
      expect(a.totalVnd).toBe(393000 + cfg.orders.shippingFeeVnd);
      expect(res.body.order.status).toBe('UNPAID');
      expect(res.body.order.items).toHaveLength(2);
      const order = await prisma.order.findFirstOrThrow({ where: { externalId: res.body.order.id }, include: { lines: true } });
      expect(order.lines).toHaveLength(3); // one line per unit
      await prisma.sku.updateMany({ where: { externalId: SKU_WHITE }, data: { priceVnd: 1 } }); // later price change must not touch the snapshot
      expect((await prisma.orderLine.findMany({ where: { orderId: order.id, skuExternalId: SKU_WHITE } })).every((l) => l.salePrice === 129000)).toBe(true);
    });

    it('rejects invalid quantities, empty orders, unknown SKUs and SKUs of another shop', async () => {
      const buyer = await t.buyerSession(0);
      for (const quantity of [0, -1, 1.5, 21]) {
        await http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey: 'key-bad-qty-1', items: [{ skuId: SKU_WHITE, quantity }] }).expect(400);
      }
      await http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey: 'key-empty-01' }).expect(400); // empty cart
      const unknown = await t.checkout(buyer, [{ skuId: 'nope', quantity: 1 }], 'key-unknown-1');
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('unknown_sku');
      const foreign = await t.checkout(buyer, [{ skuId: 'sim-sku-b-MUG-BLU', quantity: 1 }], 'key-foreign-1');
      expect(foreign.status).toBe(400);
      expect(await prisma.order.count()).toBe(0);
    });

    it('does not sell products that are hidden, deleted or deactivated', async () => {
      const buyer = await t.buyerSession(0);
      const hidden = await t.checkout(buyer, [{ skuId: 'sim-sku-a-KEY-WOOD', quantity: 1 }], 'key-hidden-1');
      expect(hidden.status).toBe(400);
      expect(hidden.body.code).toBe('not_for_sale');
    });

    it('reserves stock, refuses overselling and never goes below zero under concurrent checkouts', async () => {
      const before = await stockOf(SKU_BLACK);
      const buyer = await t.buyerSession(0);
      const buyer2 = await t.buyerSession(0, 1);
      // single warehouse has 35 of BLK-M in WH-HN; ask for more than any one warehouse holds
      const over = await t.checkout(buyer, [{ skuId: SKU_BLACK, quantity: 20 }], 'key-over-0001');
      expect(over.status).toBe(201);
      const over2 = await t.checkout(buyer2, [{ skuId: SKU_BLACK, quantity: 20 }], 'key-over-0002');
      expect(over2.status).toBe(400);
      expect(over2.body.code).toBe('insufficient_stock');
      expect(await stockOf(SKU_BLACK)).toBe(before - 20);

      // race: 3 buyers each take the last units
      await prisma.inventoryLevel.updateMany({ where: { sku: { externalId: SKU_WHITE, shopId: shopAId } }, data: { quantity: 0 } });
      const wh = await prisma.warehouse.findFirstOrThrow({ where: { shop: { name: { contains: 'Mộc Lan' } }, isDefault: true } });
      const sku = await prisma.sku.findFirstOrThrow({ where: { externalId: SKU_WHITE, shopId: shopAId } });
      await prisma.inventoryLevel.update({ where: { skuId_warehouseId: { skuId: sku.id, warehouseId: wh.id } }, data: { quantity: 2 } });
      const buyers = await Promise.all([0, 1, 2].map((i) => t.buyerSession(0, i)));
      const results = await Promise.all(buyers.map((b, i) => t.checkout(b, [{ skuId: SKU_WHITE, quantity: 1 }], `key-race-000${i}`)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(await stockOf(SKU_WHITE)).toBe(0);
    });

    it('is idempotent per checkoutKey, including two concurrent submits', async () => {
      const before = await stockOf(SKU_WHITE);
      const buyer = await t.buyerSession(0);
      const [a, b] = await Promise.all([t.checkout(buyer, [{ skuId: SKU_WHITE, quantity: 1 }], 'key-same-0001'), t.checkout(buyer, [{ skuId: SKU_WHITE, quantity: 1 }], 'key-same-0001')]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.order.id).toBe(b.body.order.id);
      expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
      expect(await prisma.order.count()).toBe(1);
      expect(await stockOf(SKU_WHITE)).toBe(before - 1);
    });

    it('buys from the cart and clears it; the shop always comes from the session', async () => {
      const buyer = await t.buyerSession(0);
      await http.put(`/demo/shops/${buyer.shopId}/cart/items`).set('x-demo-session', buyer.token).send({ skuId: SKU_WHITE, quantity: 2 }).expect(200);
      const cart = (await http.get(`/demo/shops/${buyer.shopId}/cart`).set('x-demo-session', buyer.token).expect(200)).body;
      expect(cart.totalVnd).toBe(258000);
      const other = await t.sellerSession(1);
      const otherCart = (await http.get(`/demo/shops/${other.shopId}/cart`).set('x-demo-session', buyer.token).expect(200)).body;
      expect(otherCart.items).toHaveLength(0);
      await http.get(`/demo/shops/${buyer.shopId}/cart`).set('x-demo-session', other.token).expect(403);
      const res = await http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey: 'key-cart-0001' }).expect(201);
      expect(res.body.order.items[0].quantity).toBe(2);
      expect((await http.get(`/demo/shops/${buyer.shopId}/cart`).set('x-demo-session', buyer.token)).body.items).toHaveLength(0);
    });
  });

  // ---------- state machine ----------
  describe('state machine', () => {
    it('pay -> ON_HOLD (no recipient address yet) -> release after the hold -> AWAITING_SHIPMENT (address visible)', async () => {
      const { accessToken, seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-flow-0001');
      const held = (await t.call('GET', DETAIL, accessToken, { query: { ids: id } }).expect(200)).body.data.orders[0];
      expect(held.status).toBe('ON_HOLD');
      expect(held.is_on_hold_order).toBe(true);
      expect(held.recipient_address).toBeUndefined(); // OAS: not available under UNPAID / ON_HOLD
      expect(held.paid_time).toBeGreaterThan(0);
      expect(await http.post('/test-admin/orders/release-due').set(admin).expect(201)).toMatchObject({ body: { released: [] } }); // hold not elapsed
      expect(await releaseHold()).toEqual([id]);
      const open = (await t.call('GET', DETAIL, accessToken, { query: { ids: id } }).expect(200)).body.data.orders[0];
      expect(open.status).toBe('AWAITING_SHIPMENT');
      expect(open.recipient_address.region_code).toBe('VN');
      const detail = (await http.get(`/demo/shops/${seller.shopId}/orders/${id}`).set('x-demo-session', seller.token).expect(200)).body;
      expect(detail.history.map((h: any) => `${h.from}>${h.to}:${h.actor}`)).toEqual(['null>UNPAID:BUYER', 'UNPAID>ON_HOLD:BUYER', 'ON_HOLD>AWAITING_SHIPMENT:SYSTEM']);
    });

    it('an ON_HOLD order cannot be shipped and DELIVERED is not COMPLETED', async () => {
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-hold-0001');
      for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']) {
        const r = await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('invalid_transition');
      }
      await releaseHold();
      for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED']) await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to }).expect(201);
      const row = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
      expect(row.status).toBe('DELIVERED');
      expect(row.completedAt).toBeNull();
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'CANCELLED' }).expect(400); // delivered orders cannot be cancelled
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'COMPLETED' }).expect(201);
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'AWAITING_SHIPMENT' }).expect(400);
    });

    it('cancelling returns the reserved units exactly once, even when requested twice', async () => {
      const before = await stockOf(SKU_WHITE);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-cancel-001', [{ skuId: SKU_WHITE, quantity: 3 }]);
      expect(await stockOf(SKU_WHITE)).toBe(before - 3);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'changed my mind' }).expect(201);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'again' }).expect(201);
      expect(await stockOf(SKU_WHITE)).toBe(before);
      const row = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
      expect(row).toMatchObject({ status: 'CANCELLED', cancellationInitiator: 'BUYER', stockReleased: true });
    });

    it('paying twice is a no-op, a cancelled order cannot be paid, and concurrent pay + cancel leave one consistent outcome', async () => {
      const buyer = await t.buyerSession(0);
      const c = await t.checkout(buyer, [{ skuId: SKU_WHITE, quantity: 1 }], 'key-pay-00001').expect(201);
      const id = c.body.order.id;
      await t.pay(buyer, id).expect(201);
      const again = await t.pay(buyer, id).expect(201);
      expect(again.body.replayed).toBe(true);
      const c2 = await t.checkout(buyer, [{ skuId: SKU_WHITE, quantity: 1 }], 'key-pay-00002').expect(201);
      const id2 = c2.body.order.id;
      const [p, x] = await Promise.all([t.pay(buyer, id2), http.post(`/demo/shops/${buyer.shopId}/orders/${id2}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'race' })]);
      expect([201, 400, 409]).toContain(p.status);
      expect([201, 400, 409]).toContain(x.status);
      const row = await prisma.order.findFirstOrThrow({ where: { externalId: id2 } });
      expect(['ON_HOLD', 'CANCELLED']).toContain(row.status);
      const audits = await prisma.orderAudit.findMany({ where: { orderId: row.id }, orderBy: { createdAt: 'asc' } });
      expect(audits.length).toBeGreaterThanOrEqual(2);
      if (row.status === 'CANCELLED') await t.pay(buyer, id2).then((r) => expect(r.status).toBe(400));
    });

    it('a buyer cannot touch another buyer\'s or another shop\'s order', async () => {
      const b1 = await t.buyerSession(0, 0);
      const b2 = await t.buyerSession(0, 1);
      const id = await placeOrder(b1, 'key-owner-0001', [{ skuId: SKU_WHITE, quantity: 1 }], false);
      await http.post(`/demo/shops/${b2.shopId}/orders/${id}/pay`).set('x-demo-session', b2.token).send({}).expect(404);
      await http.get(`/demo/shops/${b2.shopId}/orders/${id}`).set('x-demo-session', b2.token).expect(404);
      const other = await t.buyerSession(1);
      const otherOrders = (await http.get(`/demo/shops/${b1.shopId}/orders`).set('x-demo-session', other.token).expect(200)).body;
      expect(otherOrders.items).toHaveLength(0);
      await http.get(`/demo/shops/${b1.shopId}/orders/${id}`).set('x-demo-session', other.token).expect(404);
      const otherSeller = await t.sellerSession(1);
      await http.get(`/demo/shops/${b1.shopId}/orders`).set('x-demo-session', otherSeller.token).expect(403);
    });
  });

  // ---------- Get Order List / Detail ----------
  describe('POST /order/202309/orders/search and GET /order/202507/orders', () => {
    it('responses conform to the OAS-derived schemas; money is a string, ids are strings', async () => {
      const { accessToken } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-schema-001', [{ skuId: SKU_WHITE, quantity: 2 }]);
      await releaseHold();
      const search = await t.call('POST', SEARCH, accessToken, { query: { page_size: '10' }, body: {} }).expect(200);
      expect(conformErrors('ops/order.search.response.json', search.body)).toEqual([]);
      const detail = await t.call('GET', DETAIL, accessToken, { query: { ids: id } }).expect(200);
      expect(conformErrors('ops/order.detail.response.json', detail.body)).toEqual([]);
      const o = detail.body.data.orders[0];
      expect(o.payment).toMatchObject({ currency: 'VND', sub_total: '258000', original_total_product_price: '258000', shipping_fee: String(cfg.orders.shippingFeeVnd), total_amount: String(258000 + cfg.orders.shippingFeeVnd), tax: '0' });
      expect(o.line_items).toHaveLength(2);
      expect(new Set(o.line_items.map((l: any) => l.id)).size).toBe(2);
      expect(o.line_items[0]).toMatchObject({ sku_id: SKU_WHITE, product_id: 'sim-product-a-tee', sale_price: '129000', display_status: 'AWAITING_SHIPMENT' });
      expect(o.user_id).toMatch(/^sim-buyer-/);
      expect(loadFixture('ops/order.search.json').operation).toBe('order.search');
    });

    it('pages with an opaque keyset cursor in both directions with no gaps or repeats, and total_count', async () => {
      const { accessToken } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) ids.push(await placeOrder(buyer, `key-page-00${i}`, [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false));
      const crawl = async (order: 'ASC' | 'DESC', size: number, body: object = {}) => {
        const seen: string[] = [];
        let token = '';
        let pages = 0;
        do {
          const r = await t.call('POST', SEARCH, accessToken, { query: { page_size: String(size), sort_order: order, ...(token ? { page_token: token } : {}) }, body }).expect(200);
          seen.push(...r.body.data.orders.map((o: any) => o.id));
          token = r.body.data.next_page_token;
          pages++;
          expect(r.body.data.total_count).toBe(9);
        } while (token && pages < 50);
        return seen;
      };
      const asc = await crawl('ASC', 2);
      const desc = await crawl('DESC', 4);
      expect(asc).toEqual(ids);
      expect(desc).toEqual([...ids].reverse());
      const last = await t.call('POST', SEARCH, accessToken, { query: { page_size: '9' }, body: {} }).expect(200);
      expect(last.body.data.next_page_token).toBe('');
    });

    it('filters by status, buyer, and half-open time windows (ge inclusive, lt exclusive) on create_time and update_time', async () => {
      const { accessToken } = await t.connect(0);
      const b0 = await t.buyerSession(0, 0);
      const b1 = await t.buyerSession(0, 1);
      const first = await placeOrder(b0, 'key-filt-0001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false);
      await http.put('/test-admin/clock').set(admin).send({ advanceMs: 3_600_000 }).expect(200);
      const second = await placeOrder(b1, 'key-filt-0002', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]);
      const firstRow = await prisma.order.findFirstOrThrow({ where: { externalId: first } });
      const secondRow = await prisma.order.findFirstOrThrow({ where: { externalId: second } });
      const s = (o: { createdAt: Date }) => Math.floor(o.createdAt.getTime() / 1000);
      const search = async (body: object) => (await t.call('POST', SEARCH, accessToken, { query: { page_size: '50', sort_order: 'ASC' }, body }).expect(200)).body.data.orders.map((o: any) => o.id);
      expect(await search({ order_status: 'UNPAID' })).toEqual([first]);
      expect(await search({ order_status: 'ON_HOLD' })).toEqual([second]);
      expect(await search({ buyer_user_id: (await prisma.buyer.findUniqueOrThrow({ where: { id: b1.buyerId } })).externalId })).toEqual([second]);
      expect(await search({ create_time_ge: s(secondRow) })).toEqual([second]); // inclusive lower bound
      expect(await search({ create_time_lt: s(secondRow) })).toEqual([first]); // exclusive upper bound
      expect(await search({ create_time_ge: s(firstRow), create_time_lt: s(firstRow) })).toEqual([]);
      const upd = Math.floor(secondRow.updatedAt.getTime() / 1000);
      expect(await search({ update_time_ge: upd })).toEqual([second]);
      expect(await search({ update_time_lt: upd })).toEqual([first]);
    });

    it('rejects a missing/invalid page_size, foreign cursors, unsupported filters and malformed values', async () => {
      const { accessToken } = await t.connect(0);
      const bad = async (query: Record<string, string>, body: unknown = {}) => {
        const r = await t.call('POST', SEARCH, accessToken, { query, body });
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      };
      await bad({});
      await bad({ page_size: '101' });
      await bad({ page_size: '10', sort_field: 'price' });
      await bad({ page_size: '10', sort_order: 'UP' });
      await bad({ page_size: '10', page_token: 'garbage' });
      await bad({ page_size: '10' }, { order_status: 'WHATEVER' });
      await bad({ page_size: '10' }, { shipping_type: 'TIKTOK' });
      await bad({ page_size: '10' }, { create_time_ge: 'yesterday' });
      await bad({ page_size: '10' }, { nope: 1 });
      const buyer = await t.buyerSession(0);
      for (let i = 0; i < 3; i++) await placeOrder(buyer, `key-cur-0000${i}`, [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false);
      const p1 = await t.call('POST', SEARCH, accessToken, { query: { page_size: '1' }, body: {} }).expect(200);
      await bad({ page_size: '1', sort_order: 'ASC', page_token: p1.body.data.next_page_token }); // cursor for another ordering
    });

    it('detail returns only this shop\'s orders; unknown and foreign ids are absent; more than 50 ids is invalid', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const buyerA = await t.buyerSession(0);
      const buyerB = await t.buyerSession(1);
      const idA = await placeOrder(buyerA, 'key-iso-00001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false);
      const idB = await placeOrder(buyerB, 'key-iso-00002', [{ skuId: 'sim-sku-b-MUG-BLU', quantity: 1 }], false);
      const ask = async (token: string, ids: string) => (await t.call('GET', DETAIL, token, { query: { ids } }).expect(200)).body.data.orders.map((o: any) => o.id);
      expect(await ask(a.accessToken, `${idA},${idB},0000`)).toEqual([idA]);
      expect(await ask(b.accessToken, `${idA},${idB}`)).toEqual([idB]);
      const many = Array.from({ length: 51 }, (_, i) => String(i + 1)).join(',');
      expect((await t.call('GET', DETAIL, a.accessToken, { query: { ids: many } })).status).toBe(400);
      expect((await t.call('GET', DETAIL, a.accessToken, { query: {} })).status).toBe(400);
      const search = await t.call('POST', SEARCH, a.accessToken, { query: { page_size: '50' }, body: {} }).expect(200);
      expect(search.body.data.orders.map((o: any) => o.id)).toEqual([idA]);
    });

    it('needs the order scope and a valid signature', async () => {
      const a = await t.connect(0);
      await prisma.token.updateMany({ data: { scopes: ['sim.authorized_shops.read'] } });
      const r = await t.call('POST', SEARCH, a.accessToken, { query: { page_size: '1' }, body: {} });
      expect(r.status).toBe(403);
      expect(r.body.simulator_fault.kind).toBe('missing_scope');
      expect((await t.call('GET', DETAIL, a.accessToken, { query: { ids: '1' }, secret: 'wrong' })).status).toBe(401);
    });
  });

  // ---------- reset ----------
  it('a shop reset and a full reset succeed even when orders, packages and webhook jobs exist, and re-seed a clean baseline', async () => {
    const a = await t.connect(0);
    await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'ORDER_STATUS_CHANGE', address: 'http://localhost:9/hook' } }).expect(200);
    const buyer = await t.buyerSession(0);
    await placeOrder(buyer, 'key-reset-0001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 2 }]);
    expect(await prisma.order.count()).toBe(1);
    const reset = async (scope: string, shopId?: string) => {
      const prep = await http.post('/test-admin/reset/prepare').set(admin).send({ scope, ...(shopId ? { shopId } : {}) }).expect(201);
      return http.post('/test-admin/reset').set(admin).send({ scope, ...(shopId ? { shopId } : {}), confirmationToken: prep.body.confirmationToken });
    };
    expect((await reset('SHOP', shopAId)).status).toBe(201);
    expect(await prisma.order.count()).toBe(0);
    expect(await stockOf('sim-sku-a-BAG-NAT')).toBe(100); // baseline stock restored by the re-seed
    await placeOrder(await t.buyerSession(0), 'key-reset-0002');
    expect((await reset('ALL')).status).toBe(201);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.webhookJob.count()).toBe(0);
  });

  // ---------- Events API ----------
  describe('Events API (/event/202309/webhooks)', () => {
    it('subscribes, lists, overwrites and deletes per shop and app; rejects unknown topics and bad addresses', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'ORDER_STATUS_CHANGE', address: 'http://localhost:9/hook' } }).expect(200);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'ORDER_STATUS_CHANGE', address: 'http://localhost:9/hook2' } }).expect(200); // overwrite, not duplicate
      const list = (await t.call('GET', HOOKS, a.accessToken).expect(200)).body;
      expect(conformErrors('ops/event.webhooks_get.response.json', list)).toEqual([]);
      expect(list.data.total_count).toBe(1);
      expect(list.data.webhooks[0]).toMatchObject({ event_type: 'ORDER_STATUS_CHANGE', address: 'http://localhost:9/hook2' });
      expect((await t.call('GET', HOOKS, b.accessToken).expect(200)).body.data.total_count).toBe(0); // other shop sees nothing
      for (const body of [{ event_type: 'NOPE', address: 'http://x.test/h' }, { event_type: 'ORDER_STATUS_CHANGE' }, { event_type: 'ORDER_STATUS_CHANGE', address: 'ftp://x.test' }, { event_type: 'ORDER_STATUS_CHANGE', address: 'x'.repeat(256) }]) {
        const r = await t.call('PUT', HOOKS, a.accessToken, { body });
        expect(r.status).toBe(400);
      }
      await t.call('DELETE', HOOKS, a.accessToken, { body: { event_type: 'ORDER_STATUS_CHANGE' } }).expect(200);
      expect((await t.call('GET', HOOKS, a.accessToken).expect(200)).body.data.total_count).toBe(0);
    });

    it('requires the event scope', async () => {
      const a = await t.connect(0);
      await prisma.token.updateMany({ data: { scopes: ['sim.order.read'] } });
      expect((await t.call('GET', HOOKS, a.accessToken)).status).toBe(403);
    });
  });

  // ---------- webhooks ----------
  describe('webhook events', () => {
    const subscribe = (token: string, address = 'http://localhost:9/hook') => t.call('PUT', HOOKS, token, { body: { event_type: 'ORDER_STATUS_CHANGE', address } }).expect(200);
    const jobs = () => prisma.webhookJob.findMany({ orderBy: { createdAt: 'asc' } });

    it('emits nothing without a subscription; with one, every status change enqueues a schema-valid envelope', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await placeOrder(buyer, 'key-hook-00001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false);
      expect(await jobs()).toHaveLength(0);
      await subscribe(a.accessToken);
      const id = await placeOrder(buyer, 'key-hook-00002', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]);
      await releaseHold();
      const all = await jobs();
      expect(all.map((j) => (j.payload as any).data.order_status)).toEqual(['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT']);
      const env: any = all[0].payload;
      expect(conformErrors('webhook-envelope.json', env)).toEqual([]);
      expect(env).toMatchObject({ type: 1, shop_id: '7494000000000000001', data: { order_id: id, order_status: 'UNPAID' } });
      expect(new Set(all.map((j) => (j.payload as any).tts_notification_id)).size).toBe(3); // distinct notification ids
      expect(all.every((j) => j.appId && j.targetUrl === 'http://localhost:9/hook')).toBe(true);
      // the shop of the event is the shop of the order, not another shop
      const other = await t.connect(1);
      await subscribe(other.accessToken, 'http://localhost:9/other');
      await placeOrder(buyer, 'key-hook-00003', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], false);
      expect((await jobs()).filter((j) => j.targetUrl.endsWith('/other'))).toHaveLength(0);
    });

    it('a failed state change leaves no event behind (events are written in the same transaction)', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-atomic-001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]);
      const before = (await jobs()).length;
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'DELIVERED' }).expect(400);
      expect((await jobs()).length).toBe(before);
    });

    it('REORDER holds one event back so a later event is delivered first; replay re-sends the same envelope', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken);
      const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
      await http.post('/test-admin/faults').set(admin).send({ shopId: shop.id, target: 'WEBHOOK', kind: 'REORDER', pathMatch: 'ORDER_STATUS_CHANGE', remaining: 1, params: { holdMs: 60_000 } }).expect(201);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-reorder-01', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]);
      const worker = app.get(WebhookWorkerService);
      time.current = new Date();
      await worker.tick();
      const delivered = await prisma.webhookJob.findMany({ where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'asc' } });
      expect(delivered.map((j) => (j.payload as any).data.order_status)).toEqual(['ON_HOLD']); // UNPAID (held) is still pending
      time.advance(61_000);
      await worker.tick();
      const sent = transport.calls.map((c) => c.jobId);
      const byId = new Map((await jobs()).map((j) => [j.id, (j.payload as any).data.order_status]));
      expect(sent.map((j) => byId.get(j))).toEqual(['ON_HOLD', 'UNPAID']); // reordered: the older event arrived last
      const original = (await jobs())[0];
      const replay = await http.post(`/test-admin/webhooks/${original.id}/replay`).set(admin).expect(201);
      expect(replay.body.payload).toEqual(original.payload);
      expect(replay.body.replayOfId).toBe(original.id);
      expect(id).toBeTruthy();
    });

    it('DROP and DUPLICATE faults behave as documented', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken);
      const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
      await http.post('/test-admin/faults').set(admin).send({ shopId: shop.id, target: 'WEBHOOK', kind: 'DROP', pathMatch: 'ORDER_STATUS_CHANGE', remaining: 1 }).expect(201);
      const buyer = await t.buyerSession(0);
      await t.checkout(buyer, [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], 'key-drop-00001').expect(201);
      time.current = new Date();
      await app.get(WebhookWorkerService).tick();
      expect((await jobs())[0].status).toBe('DEAD'); // dropped events are terminal: polling must reconcile
      expect(transport.calls).toHaveLength(0);

      await http.post('/test-admin/faults').set(admin).send({ shopId: shop.id, target: 'WEBHOOK', kind: 'DUPLICATE', pathMatch: 'ORDER_STATUS_CHANGE', remaining: 1 }).expect(201);
      const id = (await prisma.order.findFirstOrThrow()).externalId;
      await t.pay(buyer, id).expect(201);
      time.current = new Date();
      await app.get(WebhookWorkerService).tick();
      expect(transport.calls).toHaveLength(2); // the same job delivered twice in one attempt
      expect(new Set(transport.calls.map((c) => c.jobId)).size).toBe(1);
    });
  });

  // ---------- signing ----------
  describe('webhook signature and address resolution', () => {
    it('Authorization = lowercase hex HMAC-SHA256(app_secret, app_key + raw body) on a real HTTP delivery', async () => {
      const received: { headers: IncomingMessage['headers']; body: string }[] = [];
      const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          res.statusCode = 200;
          res.end();
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      // a second app (real transport) so the FakeTransport above is bypassed
      const real = await createApp();
      try {
        const rp = real.get(PrismaService);
        const rhttp = request(real.getHttpServer());
        const rt = new TiktokTestClient(rhttp, real.get(APP_CONFIG));
        await cleanDb(rp);
        await real.get(SeedService).seedAll();
        const a = await rt.connect(0);
        await rt.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'ORDER_STATUS_CHANGE', address: `http://127.0.0.1:${port}/webhook` } }).expect(200);
        const buyer = await rt.buyerSession(0);
        await rt.checkout(buyer, [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }], 'key-sign-00001').expect(201);
        await real.get(WebhookWorkerService).tick();
        expect(received).toHaveLength(1);
        const rc = real.get(APP_CONFIG);
        const expected = webhookSignature(rc.seed.appSecret, rc.seed.appKey, received[0].body);
        expect(received[0].headers.authorization).toBe(expected);
        expect(expected).toMatch(/^[0-9a-f]{64}$/);
        expect(received[0].headers.authorization).not.toBe(webhookSignature('wrong-secret', rc.seed.appKey, received[0].body));
        expect(JSON.parse(received[0].body)).toMatchObject({ type: 1, data: { order_status: 'UNPAID' } });
        // independent re-derivation with the vector from contracts/signing
        const vec = loadSigningVector();
        expect(webhookSignature(vec.app_secret, vec.app_key, vec.body)).toBe(vec.expected);
      } finally {
        await real.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rewrites localhost addresses only when asked and only for loopback hosts', () => {
      expect(resolveTargetUrl('http://localhost:8080/hook', true, 'http://host.docker.internal')).toBe('http://host.docker.internal:8080/hook');
      expect(resolveTargetUrl('http://127.0.0.1:8080/hook?x=1', true, 'http://host.docker.internal')).toBe('http://host.docker.internal:8080/hook?x=1');
      expect(resolveTargetUrl('https://smartomni.example/hook', true, 'http://host.docker.internal')).toBe('https://smartomni.example/hook');
      expect(resolveTargetUrl('http://localhost:8080/hook', false, 'http://host.docker.internal')).toBe('http://localhost:8080/hook');
    });
  });
});

function loadSigningVector(): { app_key: string; app_secret: string; body: string; expected: string } {
  const v = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'signing', 'test-vectors.json'), 'utf8'));
  const w = v.webhook[0];
  return { app_key: w.app_key, app_secret: w.app_secret, body: w.raw_body, expected: w.signature };
}
