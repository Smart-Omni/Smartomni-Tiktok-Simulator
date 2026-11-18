import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const BAG = 'sim-sku-a-BAG-NAT'; // 99000

describe('OAS alignment P1: Seller Cancel Order, Create Return, Calculate Refund', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;
  let shopAId: string;
  let token: string;

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

  const stockOf = async (sku: string) => (await prisma.inventoryLevel.findMany({ where: { sku: { externalId: sku, shopId: shopAId } } })).reduce((n, l) => n + l.quantity, 0);
  const transition = (id: string, to: string) => http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to }).expect(201);
  const advanceClock = (ms: number) => http.put('/test-admin/clock').set(admin).send({ advanceMs: ms }).expect(200);

  async function unpaidOrder(buyer: { token: string; shopId: string }, key: string, quantity = 1) {
    return (await t.checkout(buyer, [{ skuId: BAG, quantity }], key).expect(201)).body.order.id as string;
  }
  async function onHoldOrder(buyer: { token: string; shopId: string }, key: string, quantity = 1) {
    const id = await unpaidOrder(buyer, key, quantity);
    await t.pay(buyer, id).expect(201);
    return id;
  }
  async function paidOrder(buyer: { token: string; shopId: string }, key: string, quantity = 1) {
    const id = await onHoldOrder(buyer, key, quantity);
    await advanceClock((cfg.orders.holdMinutes + 1) * 60_000);
    await http.post('/test-admin/orders/release-due').set(admin).expect(201);
    return id;
  }
  async function deliveredOrder(buyer: { token: string; shopId: string }, key: string, quantity = 3) {
    const id = await paidOrder(buyer, key, quantity);
    for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED']) await transition(id, to);
    return id;
  }
  const status = async (id: string) => (await prisma.order.findFirstOrThrow({ where: { externalId: id } })).status;
  const cancel = (body: unknown, tok = token) => t.call('POST', '/return_refund/202309/cancellations', tok, { body });

  describe('Seller Cancel Order', () => {
    it('cancels an AWAITING_SHIPMENT order, restores stock once, writes a SELLER record and is idempotent', async () => {
      const buyer = await t.buyerSession(0);
      const before = await stockOf(BAG);
      const id = await paidOrder(buyer, 'key-sc-0001', 2);
      expect(await stockOf(BAG)).toBe(before - 2);
      const r = await cancel({ order_id: id, cancel_reason: 'OUT_OF_STOCK' }).expect(200);
      expect(r.body.data.cancel_status).toBe('CANCELLATION_REQUEST_SUCCESS');
      expect(await status(id)).toBe('CANCELLED');
      expect(await stockOf(BAG)).toBe(before);
      const row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: r.body.data.cancel_id } });
      expect(row).toMatchObject({ role: 'SELLER', kind: 'CANCELLATION', type: 'CANCEL' });
      const again = await cancel({ order_id: id, cancel_reason: 'OUT_OF_STOCK' }).expect(200);
      expect(again.body.data.cancel_id).toBe(r.body.data.cancel_id);
      expect(await stockOf(BAG)).toBe(before); // stock is not restored twice
      expect(await prisma.aftersaleRequest.count({ where: { kind: 'CANCELLATION' } })).toBe(1);
    });

    it('cancels UNPAID and ON_HOLD orders; an unpaid order refunds nothing', async () => {
      const buyer = await t.buyerSession(0);
      const unpaid = await unpaidOrder(buyer, 'key-sc-unpd1');
      const a = await cancel({ order_id: unpaid, cancel_reason: 'OTHER' }).expect(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: a.body.data.cancel_id } })).refundTotal).toBe(0);
      const hold = await onHoldOrder(buyer, 'key-sc-hold1');
      const b = await cancel({ order_id: hold, cancel_reason: 'OTHER' }).expect(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: b.body.data.cancel_id } })).refundTotal).toBeGreaterThan(0);
      expect(await status(hold)).toBe('CANCELLED');
    });

    it('refuses states after shipping', async () => {
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-sc-ship1', 1);
      await transition(id, 'AWAITING_COLLECTION');
      const r = await cancel({ order_id: id, cancel_reason: 'OTHER' }).expect(400);
      expect(r.body.simulator_fault.kind).toBe('invalid_input');
      expect(await status(id)).toBe('AWAITING_COLLECTION');
    });

    it('refuses partial lines or skus, unknown orders and a missing reason', async () => {
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-sc-bad01', 2);
      const lines = await prisma.orderLine.findMany({ where: { order: { externalId: id } } });
      const partial = await cancel({ order_id: id, cancel_reason: 'OTHER', order_line_item_ids: [lines[0].externalId] }).expect(400);
      expect(partial.body.simulator_fault.kind).toBe('invalid_input');
      await cancel({ order_id: id }).expect(400);
      const missing = await cancel({ order_id: '1', cancel_reason: 'OTHER' }).expect(404);
      expect(missing.body.simulator_fault.kind).toBe('order_not_found');
      const bySku = await cancel({ order_id: id, cancel_reason: 'OTHER', skus: [{ sku_id: BAG, quantity: 1 }] }).expect(400);
      expect(bySku.body.simulator_fault.kind).toBe('invalid_input');
      expect(await status(id)).toBe('AWAITING_SHIPMENT');
      const whole = await cancel({ order_id: id, cancel_reason: 'OTHER', skus: [{ sku_id: BAG, quantity: 2 }] }).expect(200);
      expect(whole.body.data.cancel_status).toBe('CANCELLATION_REQUEST_SUCCESS');
    });

    it('with every line id it succeeds; a pending buyer request is closed by it; a buyer-cancelled order is not re-claimed', async () => {
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-sc-pend1', 2);
      await http.post(`/demo/shops/${buyer.shopId}/aftersale/cancellations`).set('x-demo-session', buyer.token).send({ orderId: id, reason: 'CHANGED_MIND' }).expect(201);
      const lines = await prisma.orderLine.findMany({ where: { order: { externalId: id } } });
      const r = await cancel({ order_id: id, cancel_reason: 'OTHER', order_line_item_ids: lines.map((l) => l.externalId) }).expect(200);
      expect(r.body.data.cancel_status).toBe('CANCELLATION_REQUEST_SUCCESS');
      expect(await prisma.aftersaleRequest.count({ where: { kind: 'CANCELLATION' } })).toBe(1);
    });

    it('rejects a bad token and a wrong shop_cipher', async () => {
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-sc-auth1');
      await cancel({ order_id: id, cancel_reason: 'OTHER' }, 'bad-token').expect((res) => {
        if (res.status < 400) throw new Error(`expected an error, got ${res.status}`);
      });
      const cipher = await t.call('POST', '/return_refund/202309/cancellations', token, { query: { shop_cipher: 'wrong' }, body: { order_id: id, cancel_reason: 'OTHER' } }).expect(403);
      expect(cipher.body.simulator_fault.kind).toBe('shop_cipher_mismatch');
      expect(await status(id)).toBe('AWAITING_SHIPMENT');
    });
  });

  describe('Create Return', () => {
    const create = (body: unknown, key?: string) => t.call('POST', '/return_refund/202309/returns', token, { query: key ? { idempotency_key: key } : {}, body });

    it('creates a SELLER return by sku and by line ids, in the same shape the buyer path stores', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-cr-0001', 3);
      const r1 = await create({ order_id: id, return_type: 'REFUND', return_reason: 'DAMAGED_ITEM', skus: [{ sku_id: BAG, quantity: 1 }] }).expect(200);
      expect(r1.body.data.return_status).toBe('RETURN_OR_REFUND_REQUEST_PENDING');
      const row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: r1.body.data.return_id }, include: { records: true } });
      expect(row).toMatchObject({ role: 'SELLER', refundTotal: 99000 });
      expect(row.records[0].actor).toBe('SELLER');
      const free = await prisma.orderLine.findMany({ where: { order: { externalId: id }, aftersaleLines: { none: { active: true } } } });
      expect(free).toHaveLength(2);
      await create({ order_id: id, return_type: 'RETURN_AND_REFUND', return_reason: 'OTHER', order_line_item_ids: [free[0].externalId] }).expect(200);
      expect(await status(id)).toBe('DELIVERED');
    });

    it('is idempotent per key: same return_id, one row, one set of webhooks', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-cr-idem1', 2);
      const body = { order_id: id, return_type: 'REFUND', return_reason: 'OTHER', skus: [{ sku_id: BAG, quantity: 1 }] };
      const a = await create(body, 'idem-1').expect(200);
      const jobs = await prisma.webhookJob.count();
      const b = await create(body, 'idem-1').expect(200);
      expect(b.body.data.return_id).toBe(a.body.data.return_id);
      expect(await prisma.aftersaleRequest.count({ where: { kind: 'RETURN' } })).toBe(1);
      expect(await prisma.webhookJob.count()).toBe(jobs);
      const parallel = await Promise.all([create(body, 'idem-2'), create(body, 'idem-2'), create(body, 'idem-2')]);
      expect(new Set(parallel.filter((p) => p.status === 200).map((p) => p.body.data.return_id)).size).toBe(1);
      expect(await prisma.aftersaleRequest.count({ where: { kind: 'RETURN' } })).toBe(2);
      const other = await deliveredOrder(buyer, 'key-cr-idem2', 1);
      await create({ ...body, order_id: other }, 'idem-1').expect(400); // same key, different order
    });

    it('validates refund_total, currency, return_type, state and units', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-cr-val01', 2);
      const base = { order_id: id, return_type: 'REFUND', return_reason: 'OTHER', skus: [{ sku_id: BAG, quantity: 1 }] };
      await create({ ...base, refund_total: '99001' }).expect(400);
      await create({ ...base, refund_total: '0' }).expect(400);
      await create({ ...base, refund_total: '1.5' }).expect(400);
      await create({ ...base, currency: 'USD' }).expect(400);
      await create({ ...base, return_type: 'EXCHANGE' }).expect(400);
      await create({ ...base, skus: [{ sku_id: BAG, quantity: 5 }] }).expect(400);
      await create({ order_id: id, return_type: 'REFUND', return_reason: 'OTHER' }).expect(400);
      const partial = await create({ ...base, refund_total: '50000' }).expect(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: partial.body.data.return_id } })).refundTotal).toBe(50000);
      const paid = await paidOrder(buyer, 'key-cr-val02', 1);
      await create({ ...base, order_id: paid }).expect(400);
      await create({ ...base, order_id: '1' }).expect(404);
    });
  });

  describe('Calculate Refund', () => {
    const calc = (body: unknown) => t.call('POST', '/return_refund/202309/refunds/calculate', token, { body });

    it('returns string amounts, charges shipping only for CANCEL or the whole order, and writes nothing', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-calc-001', 3);
      const order = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
      const ship = order.originalShippingFee - order.shippingFeeDiscount;
      const one = await calc({ order_id: id, request_type: 'REFUND', skus: [{ sku_id: BAG, quantity: 1 }] }).expect(200);
      expect(one.body.data.order_refund_amount).toEqual({ currency: 'VND', refund_subtotal: '99000', refund_shipping_fee: '0', refund_tax: '0', refund_total: '99000' });
      const all = await calc({ order_id: id, request_type: 'RETURN_AND_REFUND' }).expect(200);
      expect(all.body.data.order_refund_amount.refund_subtotal).toBe('297000');
      expect(all.body.data.order_refund_amount.refund_shipping_fee).toBe(String(Math.max(0, ship)));
      expect(await prisma.aftersaleRequest.count()).toBe(0);
      await calc({ order_id: id, request_type: 'NOPE' }).expect(400);
      await calc({ order_id: '1', request_type: 'REFUND' }).expect(404);
    });
  });
});
