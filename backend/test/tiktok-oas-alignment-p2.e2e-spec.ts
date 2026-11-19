import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const BAG = 'sim-sku-a-BAG-NAT';

describe('OAS alignment P2: handover/shipping info/deliver, logistics, price detail, agent settings, deauthorize, partial edit, sandbox', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;
  let token: string;
  let shopAId: string;

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
    await app.get(PersistentBusinessClock).reset();
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
    token = (await t.connect(0)).accessToken;
  });

  const advanceClock = (ms: number) => http.put('/test-admin/clock').set(admin).send({ advanceMs: ms }).expect(200);
  async function awaitingShipment(buyer: { token: string; shopId: string }, key: string) {
    const id = (await t.checkout(buyer, [{ skuId: BAG, quantity: 1 }], key).expect(201)).body.order.id as string;
    await t.pay(buyer, id).expect(201);
    await advanceClock((cfg.orders.holdMinutes + 1) * 60_000);
    await http.post('/test-admin/orders/release-due').set(admin).expect(201);
    const pkg = await prisma.package.findFirstOrThrow({ where: { order: { externalId: id } } });
    return { orderId: id, packageId: pkg.externalId };
  }
  const arrange = (packageId: string) => t.call('POST', `/fulfillment/202309/packages/${packageId}/ship`, token, { body: {} }).expect(200);
  const orderStatus = async (id: string) => (await prisma.order.findFirstOrThrow({ where: { externalId: id } })).status;
  const adminTransition = (id: string, to: string) => http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to }).expect(201);

  describe('Handover time slots', () => {
    it('returns three future pickup slots and refuses unknown or cancelled packages', async () => {
      const buyer = await t.buyerSession(0);
      const { orderId, packageId } = await awaitingShipment(buyer, 'key-p2-slots1');
      const r = await t.call('GET', `/fulfillment/202309/packages/${packageId}/handover_time_slots`, token).expect(200);
      const d = r.body.data;
      expect(d).toEqual(expect.objectContaining({ can_pickup: true, can_drop_off: true, can_van_collection: false }));
      expect(d.pickup_slots).toHaveLength(3);
      const now = Date.now() / 1000;
      for (const s of d.pickup_slots) {
        expect(s.avaliable).toBe(true);
        expect(s.start_time).toBeGreaterThan(now);
        expect(s.end_time - s.start_time).toBe(3 * 3600);
      }
      await t.call('GET', '/fulfillment/202309/packages/1/handover_time_slots', token).expect(404);
      await adminTransition(orderId, 'CANCELLED');
      await t.call('GET', `/fulfillment/202309/packages/${packageId}/handover_time_slots`, token).expect(400);
    });
  });

  describe('Update package shipping info', () => {
    it('needs an arranged package, replaces tracking and carrier, drops cached labels and emits PACKAGE_UPDATE', async () => {
      const buyer = await t.buyerSession(0);
      const { packageId } = await awaitingShipment(buyer, 'key-p2-info1');
      const upd = (body: unknown, id = packageId) => t.call('POST', `/fulfillment/202309/packages/${id}/shipping_info/update`, token, { body });
      await upd({ tracking_number: 'ABC123', shipping_provider_id: 'SIM-CARRIER-2' }).expect(400); // not arranged yet
      await arrange(packageId);
      await t.call('PUT', '/event/202309/webhooks', token, { body: { event_type: 'PACKAGE_UPDATE', address: 'http://localhost:9/hook' } }).expect(200);
      await t.call('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, token, { query: { document_type: 'SHIPPING_LABEL' } }).expect(200);
      expect(await prisma.shippingDocument.count()).toBe(1);
      await upd({ tracking_number: 'ABC-123', shipping_provider_id: 'SIM-CARRIER-2' }).expect(200);
      const pkg = await prisma.package.findFirstOrThrow({ where: { externalId: packageId } });
      expect(pkg).toEqual(expect.objectContaining({ trackingNumber: 'ABC-123', shippingProviderId: 'SIM-CARRIER-2' }));
      expect(await prisma.shippingDocument.count()).toBe(0);
      expect(await prisma.webhookJob.count({ where: { topic: 'PACKAGE_UPDATE' } })).toBe(1);
      const doc = await t.call('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, token, { query: { document_type: 'SHIPPING_LABEL' } }).expect(200);
      expect(doc.body.data.tracking_number).toBe('ABC-123');
      await upd({ tracking_number: 'bad number!', shipping_provider_id: 'SIM-CARRIER-2' }).expect(400);
      await upd({ tracking_number: 'OK1', shipping_provider_id: 'NOT-A-CARRIER' }).expect(400);
      await upd({ tracking_number: 'OK1' }).expect(400);
      await upd({ tracking_number: 'OK1', shipping_provider_id: 'SIM-CARRIER-1', extra: 1 }).expect(400);
      await upd({ tracking_number: 'OK1', shipping_provider_id: 'SIM-CARRIER-1' }, '1').expect(404);
    });
  });

  describe('Update package delivery status', () => {
    it('reports success and failure per package and never blocks the others', async () => {
      const buyer = await t.buyerSession(0);
      const a = await awaitingShipment(buyer, 'key-p2-del01');
      const deliver = (packages: unknown[]) => t.call('POST', '/fulfillment/202309/packages/deliver', token, { body: { packages } });
      let r = await deliver([{ id: a.packageId, delivery_type: 'DELIVERY_SUCCESS' }, { id: 'nope', delivery_type: 'DELIVERY_SUCCESS' }]).expect(200);
      expect(r.body.data.errors.map((e: any) => e.detail.package_id).sort()).toEqual([a.packageId, 'nope'].sort()); // AWAITING_SHIPMENT is not in transit
      await arrange(a.packageId);
      await adminTransition(a.orderId, 'IN_TRANSIT');
      await deliver([{ id: a.packageId, delivery_type: 'DELIVERY_FAILED' }]).expect(400);
      await deliver([{ id: a.packageId, delivery_type: 'WHATEVER' }]).expect(400);
      await deliver([]).expect(400);
      r = await deliver([{ id: a.packageId, delivery_type: 'DELIVERY_FAILED', fail_delivery_reason: 'buyer not home' }]).expect(200);
      expect(r.body.data.errors).toEqual([]);
      expect(await orderStatus(a.orderId)).toBe('IN_TRANSIT');
      const events = await prisma.trackingEvent.findMany({ where: { order: { externalId: a.orderId } } });
      expect(events.some((e) => e.description.includes('buyer not home'))).toBe(true);
      r = await deliver([{ id: a.packageId, delivery_type: 'DELIVERY_SUCCESS', file_type: 'IMG', file_url: 'https://example.test/proof.jpg' }]).expect(200);
      expect(r.body.data.errors).toEqual([]);
      expect(await orderStatus(a.orderId)).toBe('DELIVERED');
      r = await deliver([{ id: a.packageId, delivery_type: 'DELIVERY_SUCCESS' }]).expect(200);
      expect(r.body.data.errors).toEqual([]); // repeat is a no-op
    });
  });

  describe('Logistics delivery options and providers', () => {
    it('lists static options for a warehouse of the shop and the providers of an option', async () => {
      const wh = await prisma.warehouse.findFirstOrThrow({ where: { shopId: shopAId } });
      const r = await t.call('GET', `/logistics/202309/warehouses/${wh.externalId}/delivery_options`, token).expect(200);
      const options = r.body.data.delivery_options as any[];
      expect(options.map((o) => o.type)).toEqual(['STANDARD', 'EXPRESS']);
      expect(options[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), platform: ['TIKTOK_SHOP'], weight_limit: expect.any(Object), dimension_limit: expect.any(Object) }));
      await t.call('GET', '/logistics/202309/warehouses/nope/delivery_options', token).expect(404);
      await t.call('GET', `/logistics/202309/warehouses/${wh.externalId}/delivery_options`, token, { query: { scope: 'X' } }).expect(400);
      const p = await t.call('GET', `/logistics/202309/delivery_options/${options[0].id}/shipping_providers`, token).expect(200);
      expect(p.body.data.shipping_providers.length).toBeGreaterThan(0);
      expect(p.body.data.shipping_providers[0]).toEqual({ id: expect.any(String), name: expect.any(String) });
      await t.call('GET', '/logistics/202309/delivery_options/nope/shipping_providers', token).expect(404);
    });
  });

  describe('Get price detail', () => {
    it('matches the order payment, keeps amounts as strings and stays inside the shop', async () => {
      const buyer = await t.buyerSession(0);
      const id = (await t.checkout(buyer, [{ skuId: BAG, quantity: 2 }], 'key-p2-price1').expect(201)).body.order.id as string;
      const detail = (await t.call('GET', '/order/202507/orders', token, { query: { ids: id } }).expect(200)).body.data.orders[0];
      const r = await t.call('GET', `/order/202407/orders/${id}/price_detail`, token).expect(200);
      const d = r.body.data;
      expect(d.currency).toBe('VND');
      expect(typeof d.payment).toBe('string');
      expect(d.payment).toBe(detail.payment.total_amount);
      expect(d.line_items).toHaveLength(detail.line_items.length);
      const sum = (k: string) => d.line_items.reduce((n: number, l: any) => n + Number(l[k]), 0);
      expect(sum('payment')).toBe(Number(d.payment));
      expect(sum('shipping_list_price')).toBe(Number(d.shipping_list_price));
      expect(d.cod_fee).toBe('0');
      await t.call('GET', '/order/202407/orders/1/price_detail', token).expect(404);
    });
  });

  describe('Agent settings', () => {
    it('defaults to true, persists the flag and validates the body', async () => {
      const get = async () => (await t.call('GET', '/customer_service/202309/agents/settings', token).expect(200)).body.data.can_accept_chat;
      expect(await get()).toBe(true);
      expect((await t.call('PUT', '/customer_service/202309/agents/settings', token, { body: { can_accept_chat: false } }).expect(200)).body.data).toEqual({});
      expect(await get()).toBe(false);
      await t.call('PUT', '/customer_service/202309/agents/settings', token, { body: { can_accept_chat: 'no' } }).expect(400);
      await t.call('PUT', '/customer_service/202309/agents/settings', token, { body: {} }).expect(400);
      await t.call('PUT', '/customer_service/202309/agents/settings', token, { body: { can_accept_chat: true, x: 1 } }).expect(400);
      expect(await get()).toBe(false);
    });
  });

  describe('Deauthorize shop', () => {
    it('revokes the tokens of the app for the shop and queues SELLER_DEAUTHORIZATION', async () => {
      await t.call('PUT', '/event/202309/webhooks', token, { body: { event_type: 'SELLER_DEAUTHORIZATION', address: 'http://localhost:9/hook' } }).expect(200);
      expect((await t.call('DELETE', '/authorization/202403/shops', token).expect(200)).body.data).toEqual({});
      expect(await prisma.token.count({ where: { shopId: shopAId, status: 'ACTIVE' } })).toBe(0);
      expect(await prisma.webhookJob.count({ where: { topic: 'SELLER_DEAUTHORIZATION' } })).toBe(1);
      const after = await t.call('GET', '/authorization/202309/shops', token);
      expect(after.status).toBe(401);
      expect(after.body.simulator_fault.kind).toBe('authorization_revoked');
    });
  });

  describe('Partial edit product', () => {
    it('changes only the fields sent and refuses an empty body or an unknown product', async () => {
      const list = await t.call('POST', '/product/202502/products/search', token, { query: { page_size: '10' }, body: {} }).expect(200);
      const productId = list.body.data.products[0].id as string;
      const before = await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: productId }, include: { skus: true } });
      const r = await t.call('POST', `/product/202509/products/${productId}/partial_edit`, token, { body: { title: 'Partially edited' } }).expect(200);
      expect(r.body.data.product_id).toBe(productId);
      expect(r.body.data.audit).toEqual({ status: expect.any(String) });
      const after = await prisma.product.findFirstOrThrow({ where: { shopId: shopAId, externalId: productId }, include: { skus: true } });
      expect(after.title).toBe('Partially edited');
      expect(after.description).toBe(before.description);
      expect(after.skus.map((s) => s.priceVnd)).toEqual(before.skus.map((s) => s.priceVnd));
      await t.call('POST', `/product/202509/products/${productId}/partial_edit`, token, { body: {} }).expect(400);
      await t.call('POST', '/product/202509/products/1/partial_edit', token, { body: { title: 'x' } }).expect(404);
    });
  });

  describe('Sandbox controls (toolkit counterparts)', () => {
    it('GET /test-admin/shops filters by region', async () => {
      const all = (await http.get('/test-admin/shops').set(admin).expect(200)).body.items as any[];
      const vn = (await http.get('/test-admin/shops').query({ region: 'VN' }).set(admin).expect(200)).body.items as any[];
      expect(vn.length).toBe(all.filter((s) => s.region === 'VN').length);
      expect((await http.get('/test-admin/shops').query({ region: 'ZZ' }).set(admin).expect(200)).body.items).toEqual([]);
    });

    it('lists products with stock_count and limits', async () => {
      const r = await http.get('/test-admin/sandbox/products').query({ shopId: shopAId }).set(admin).expect(200);
      const bag = r.body.products.flatMap((p: any) => p.sku_list).find((s: any) => s.id === BAG);
      expect(bag.stock_count).toBeGreaterThan(0);
      expect(r.body.limits).toEqual({ max_quantity_per_sku: 20, max_order_count: 10 });
      await http.get('/test-admin/sandbox/products').query({ shopId: 'nope' }).set(admin).expect(404);
      await http.get('/test-admin/sandbox/products').expect(401);
    });

    it('creates a batch with created and failed entries and no rollback', async () => {
      await prisma.inventoryLevel.updateMany({ where: { sku: { externalId: BAG, shopId: shopAId } }, data: { quantity: 0 } });
      await prisma.inventoryLevel.updateMany({ where: { sku: { externalId: BAG, shopId: shopAId }, warehouse: { isDefault: true } }, data: { quantity: 1 } });
      const r = await http.post('/test-admin/sandbox/orders').set(admin).send({ shopId: shopAId, items: [{ sku_id: BAG, quantity: 1 }], order_count: 3, payment_method: 'SANDBOX' }).expect(201);
      expect(r.body.created).toHaveLength(1);
      expect(r.body.failed).toHaveLength(2);
      expect(r.body.created[0].status).toBe('ON_HOLD');
      const row = await prisma.order.findFirstOrThrow({ where: { externalId: r.body.created[0].order_id } });
      expect(row.paymentMethodName).toBe('SANDBOX');
      const bad = await http.post('/test-admin/sandbox/orders').set(admin).send({ shopId: shopAId, items: [{ sku_id: 'nope', quantity: 1 }] }).expect(201);
      expect(bad.body.created).toEqual([]);
      expect(bad.body.failed).toHaveLength(1);
      await http.post('/test-admin/sandbox/orders').set(admin).send({ shopId: shopAId, items: [{ sku_id: BAG, quantity: 1 }], order_count: 11 }).expect(400);
      await http.post('/test-admin/sandbox/orders').set(admin).send({ shopId: shopAId, items: [{ sku_id: BAG, quantity: 1 }], logistics_service_id: 'X' }).expect(201).expect((res) => {
        expect(res.body.created).toEqual([]);
      });
    });

    it('transitions one happy-path step at a time until COMPLETED, then reports transitioned=false', async () => {
      const made = await http.post('/test-admin/sandbox/orders').set(admin).send({ shopId: shopAId, items: [{ sku_id: BAG, quantity: 1 }], pay: false }).expect(201);
      const id = made.body.created[0].order_id as string;
      const step = async () => (await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({}).expect(201)).body;
      const seen: string[] = [];
      let r = await step();
      expect(r).toEqual(expect.objectContaining({ before_status: 'UNPAID', after_status: 'ON_HOLD', transitioned: true }));
      for (let i = 0; i < 8 && r.transitioned; i++) {
        seen.push(r.after_status);
        r = await step();
      }
      expect(seen).toEqual(['ON_HOLD', 'AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
      expect(r).toEqual(expect.objectContaining({ before_status: 'COMPLETED', after_status: 'COMPLETED', transitioned: false }));
      expect(await orderStatus(id)).toBe('COMPLETED');
      expect(await prisma.package.count({ where: { order: { externalId: id } } })).toBe(1);
    });

    it('keeps the explicit `to` behaviour and lists orders with canonical_status and pageSize', async () => {
      const buyer = await t.buyerSession(0);
      const { orderId } = await awaitingShipment(buyer, 'key-p2-canon1');
      await http.post(`/demo/shops/${buyer.shopId}/orders/${orderId}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'CHANGED_MIND' }).expect(201);
      const list = (await http.get('/test-admin/orders').query({ shopId: shopAId, pageSize: '1' }).set(admin).expect(200)).body.items as any[];
      expect(list).toHaveLength(1);
      expect(list[0].canonical_status).toBe('CANCEL_PENDING');
      expect((await http.get('/test-admin/orders').query({ shopId: shopAId, pageSize: '500' }).set(admin).expect(200)).body.items.length).toBeLessThanOrEqual(10);
      const forced = await http.post(`/test-admin/orders/${orderId}/transition`).set(admin).send({ to: 'CANCELLED' }).expect(201);
      expect(forced.body).toEqual(expect.objectContaining({ from: 'AWAITING_SHIPMENT', status: 'CANCELLED', transitioned: true }));
    });
  });
});
