import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { conformErrors } from './contract';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const RET_SEARCH = '/return_refund/202309/returns/search';
const CAN_SEARCH = '/return_refund/202309/cancellations/search';
const HOOKS = '/event/202309/webhooks';
const BAG = 'sim-sku-a-BAG-NAT'; // 99000, stock 50 + 50
const DAY = 24 * 3600 * 1000;

describe('Phase 07b: cancellations, returns/refunds and aftersale', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;
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
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
  });

  // ---------- helpers ----------
  const stockOf = async (sku: string) => (await prisma.inventoryLevel.findMany({ where: { sku: { externalId: sku, shopId: shopAId } } })).reduce((n, l) => n + l.quantity, 0);
  const transition = (id: string, to: string) => http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to }).expect(201);
  const advanceClock = (ms: number) => http.put('/test-admin/clock').set(admin).send({ advanceMs: ms }).expect(200);

  /** A paid order released from hold (AWAITING_SHIPMENT). */
  async function paidOrder(buyer: { token: string; shopId: string }, key: string, quantity = 1, sku = BAG) {
    const c = await t.checkout(buyer, [{ skuId: sku, quantity }], key).expect(201);
    const id = c.body.order.id as string;
    await t.pay(buyer, id).expect(201);
    await advanceClock((cfg.orders.holdMinutes + 1) * 60_000);
    await http.post('/test-admin/orders/release-due').set(admin).expect(201);
    return id;
  }
  async function deliveredOrder(buyer: { token: string; shopId: string }, key: string, quantity = 3, sku = BAG) {
    const id = await paidOrder(buyer, key, quantity, sku);
    for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED']) await transition(id, to);
    return id;
  }
  const askReturn = (buyer: { token: string; shopId: string }, orderId: string, quantity: number, returnType = 'REFUND', sku = BAG) =>
    http.post(`/demo/shops/${buyer.shopId}/aftersale/returns`).set('x-demo-session', buyer.token).send({ orderId, items: [{ skuId: sku, quantity }], returnType, reason: 'DAMAGED_ITEM' });
  const orderStatus = async (id: string) => (await prisma.order.findFirstOrThrow({ where: { externalId: id } })).status;

  // ---------- partial returns ----------
  describe('returns and refunds', () => {
    it('a partial return keeps the other units returnable, the order status unchanged, refunds only what was paid and never adds stock back', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-0001', 3);
      const stockAfterOrder = await stockOf(BAG);
      const r1 = await askReturn(buyer, id, 1).expect(201);
      expect(r1.body.request).toMatchObject({ kind: 'RETURN', type: 'REFUND', status: 'RETURN_OR_REFUND_REQUEST_PENDING', refund: { subtotalVnd: 99000, shippingVnd: 0, totalVnd: 99000 } });
      expect(await orderStatus(id)).toBe('DELIVERED'); // a partial return never turns the order into a "returned" order
      const elig = (await t.call('GET', `/return_refund/202512/orders/${id}/aftersale_eligibility`, a.accessToken, { query: { request_types: 'REFUND,CANCEL' } }).expect(200)).body;
      expect(conformErrors('ops/return.aftersale_eligibility.response.json', elig)).toEqual([]);
      const byType = Object.fromEntries(elig.data.sku_eligibility[0].line_item_eligibility.map((e: any) => [e.request_type, e]));
      expect(byType.REFUND.eligible).toBe(true);
      expect(byType.REFUND.order_line_items_ids).toHaveLength(2); // the other two units
      expect(byType.CANCEL.eligible).toBe(false);
      expect(byType.CANCEL.ineligible_reason).toContain('DELIVERED');
      await askReturn(buyer, id, 2).expect(201); // the remaining two units
      const over = await askReturn(buyer, id, 1);
      expect(over.status).toBe(400);
      expect(over.body.code).toBe('units_unavailable');
      const rows = await prisma.aftersaleLine.findMany({ where: { active: true, request: { order: { externalId: id } } } });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((x) => x.orderLineId)).size).toBe(3);
      expect(await stockOf(BAG)).toBe(stockAfterOrder); // SmartOmni Inventory restocks; the simulator never does
    });

    it('two concurrent requests for the last unit: exactly one wins (partial unique index), the other is refused', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-race1', 1);
      const results = await Promise.all([askReturn(buyer, id, 1), askReturn(buyer, id, 1), askReturn(buyer, id, 1)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status))).toBe(true);
      expect(await prisma.aftersaleRequest.count({ where: { kind: 'RETURN' } })).toBe(1);
      // the database itself refuses a second active row for a unit, whatever the application does
      const line = await prisma.aftersaleLine.findFirstOrThrow({ where: { active: true } });
      await expect(prisma.aftersaleLine.create({ data: { requestId: line.requestId, orderLineId: line.orderLineId, externalId: 'dup', refundSubtotal: 1, active: true } })).rejects.toThrow();
    });

    it('seller approve is idempotent, records history, and complete moves SUCCESS to COMPLETE without touching the order', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-appr1', 2);
      const rid = (await askReturn(buyer, id, 2).expect(201)).body.request.id as string;
      const approve = () => t.call('POST', `/return_refund/202309/returns/${rid}/approve`, a.accessToken, { query: { idempotency_key: 'k-1' }, body: { decision: 'APPROVE_REFUND' } });
      const first = await approve().expect(200);
      expect(conformErrors('ops/return.approve.response.json', first.body)).toEqual([]);
      const jobsAfterFirst = await prisma.webhookJob.count();
      await approve().expect(200); // same decision again: same result, no double effect
      const again = await t.call('POST', `/return_refund/202309/returns/${rid}/approve`, a.accessToken, { body: {} }).expect(200); // inferred decision, already approved
      expect(again.body.code).toBe(0);
      expect(await prisma.webhookJob.count()).toBe(jobsAfterFirst);
      const row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid }, include: { records: true } });
      expect(row.status).toBe('RETURN_OR_REFUND_REQUEST_SUCCESS');
      expect(row.records.map((r) => r.toStatus)).toEqual(['RETURN_OR_REFUND_REQUEST_PENDING', 'RETURN_OR_REFUND_REQUEST_SUCCESS']);
      const rec = await t.call('GET', `/return_refund/202309/returns/${rid}/records`, a.accessToken).expect(200);
      expect(conformErrors('ops/return.records.response.json', rec.body)).toEqual([]);
      expect(rec.body.data.records).toHaveLength(2);
      expect(rec.body.data.records[0].event).toBe('ORDER_RETURN');
      await http.post(`/test-admin/aftersale/${rid}/complete`).set(admin).expect(201);
      await http.post(`/test-admin/aftersale/${rid}/complete`).set(admin).expect(201); // idempotent
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('RETURN_OR_REFUND_REQUEST_COMPLETE');
      expect(await orderStatus(id)).toBe('DELIVERED');
      // an approved unit can never be requested again
      expect((await askReturn(buyer, id, 1)).status).toBe(400);
    });

    it('RETURN_AND_REFUND needs the buyer to ship it back; decisions must match the state; rejecting frees the units', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-full1', 2);
      const rid = (await askReturn(buyer, id, 1, 'RETURN_AND_REFUND').expect(201)).body.request.id as string;
      const call = (path: string, body: unknown) => t.call('POST', `/return_refund/202309/returns/${rid}/${path}`, a.accessToken, { body });
      let r = await call('approve', { decision: 'APPROVE_RECEIVED_PACKAGE' });
      expect(r.status).toBe(400); // nothing was shipped yet
      expect(r.body.simulator_fault.kind).toBe('invalid_decision');
      expect((await call('approve', { decision: 'APPROVE_REFUND' })).status).toBe(400); // wrong type for this request
      expect((await call('approve', { decision: 'APPROVE_RETURN' })).status).toBe(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('AWAITING_BUYER_SHIP');
      await http.post(`/demo/shops/${buyer.shopId}/aftersale/${rid}/ship-back`).set('x-demo-session', buyer.token).send({}).expect(201);
      const shipped = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } });
      expect(shipped.status).toBe('BUYER_SHIPPED_ITEM');
      expect(shipped.returnTrackingNumber).toMatch(/^SIMRET/);
      // reject the received package: units are released for a new request
      r = await call('reject', { reject_reason: 'NOT_A_REASON' });
      expect(r.status).toBe(400);
      expect((await call('reject', { decision: 'REJECT_RECEIVED_PACKAGE', reject_reason: 'ITEM_USED_OR_DAMAGED', comment: 'used' })).status).toBe(200);
      expect((await call('reject', { decision: 'REJECT_RECEIVED_PACKAGE', reject_reason: 'ITEM_USED_OR_DAMAGED' })).status).toBe(200); // repeat: no error, no new record
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid }, include: { records: true } })).records).toHaveLength(4);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('REJECT_RECEIVE_PACKAGE');
      await askReturn(buyer, id, 2).expect(201); // both units are free again
    });

    it('a buyer can withdraw a pending return (units freed); a rejected REFUND request ends in REFUND_OR_RETURN_REQUEST_REJECT', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-wdrw1', 2);
      const rid = (await askReturn(buyer, id, 1).expect(201)).body.request.id as string;
      await http.post(`/demo/shops/${buyer.shopId}/aftersale/${rid}/cancel`).set('x-demo-session', buyer.token).send({}).expect(201);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('RETURN_OR_REFUND_REQUEST_CANCEL');
      const rid2 = (await askReturn(buyer, id, 2).expect(201)).body.request.id as string;
      await t.call('POST', `/return_refund/202309/returns/${rid2}/reject`, a.accessToken, { body: { decision: 'REJECT_REFUND', reject_reason: 'ITEM_AS_DESCRIBED' } }).expect(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid2 } })).status).toBe('REFUND_OR_RETURN_REQUEST_REJECT');
      expect((await askReturn(buyer, id, 2)).status).toBe(201);
    });

    it('the return window follows the BUSINESS clock: allowed up to delivery + window, refused one second later', async () => {
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-ret-wind1', 1);
      const delivered = (await prisma.order.findFirstOrThrow({ where: { externalId: id } })).deliveredAt!;
      const freezeAt = (ms: number) => http.put('/test-admin/clock').set(admin).send({ setTo: new Date(delivered.getTime() + ms).toISOString(), freeze: true }).expect(200);
      await freezeAt(cfg.aftersale.returnWindowDays * DAY + 1000);
      const late = await askReturn(buyer, id, 1);
      expect(late.status).toBe(400);
      expect(late.body.code).toBe('return_window_closed');
      await freezeAt(cfg.aftersale.returnWindowDays * DAY);
      expect((await askReturn(buyer, id, 1)).status).toBe(201);
      await http.put('/test-admin/clock').set(admin).send({ reset: true }).expect(200);
    });

    it('orders that are not delivered, or belong to another buyer, cannot be returned', async () => {
      const b1 = await t.buyerSession(0, 0);
      const b2 = await t.buyerSession(0, 1);
      const open = await paidOrder(b1, 'key-ret-open1', 1); // AWAITING_SHIPMENT
      const notDelivered = await askReturn(b1, open, 1);
      expect(notDelivered.status).toBe(400);
      expect(notDelivered.body.code).toBe('return_not_allowed');
      const done = await deliveredOrder(b1, 'key-ret-done1', 1);
      expect((await askReturn(b2, done, 1)).status).toBe(404);
      expect((await askReturn(b1, done, 1, 'REPLACEMENT')).status).toBe(400);
    });
  });

  // ---------- cancellations ----------
  describe('cancellations', () => {
    it('buyer cancel of a paid AWAITING_SHIPMENT order is a request; approving cancels the order, restores stock once and refunds shipping too', async () => {
      const a = await t.connect(0);
      const before = await stockOf(BAG);
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-can-0001', 2);
      expect(await stockOf(BAG)).toBe(before - 2);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'CHANGED_MIND' }).expect(201);
      const row = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
      expect(row).toMatchObject({ status: 'AWAITING_SHIPMENT', buyerRequestedCancel: true });
      const search = await t.call('POST', CAN_SEARCH, a.accessToken, { query: { page_size: '10' }, body: { cancel_status: ['CANCELLATION_REQUEST_PENDING'] } }).expect(200);
      expect(conformErrors('ops/cancellation.search.response.json', search.body)).toEqual([]);
      const c = search.body.data.cancellations[0];
      expect(c).toMatchObject({ order_id: id, cancel_type: 'BUYER_CANCEL', cancel_status: 'CANCELLATION_REQUEST_PENDING', role: 'BUYER' });
      expect(c.refund_amount).toMatchObject({ currency: 'VND', refund_subtotal: '198000', refund_shipping_fee: String(cfg.orders.shippingFeeVnd), refund_total: String(198000 + cfg.orders.shippingFeeVnd) });
      expect(c.cancel_line_items).toHaveLength(2);
      const approve = () => t.call('POST', `/return_refund/202309/cancellations/${c.cancel_id}/approve`, a.accessToken, { body: {} });
      await approve().expect(200);
      await approve().expect(200); // repeat: no second restock
      const done = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
      expect(done).toMatchObject({ status: 'CANCELLED', cancellationInitiator: 'BUYER', stockReleased: true });
      expect(await stockOf(BAG)).toBe(before);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: c.cancel_id } })).status).toBe('CANCELLATION_REQUEST_SUCCESS');
      await http.post(`/test-admin/aftersale/${c.cancel_id}/complete`).set(admin).expect(201);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: c.cancel_id } })).status).toBe('CANCELLATION_REQUEST_COMPLETE');
    });

    it('rejecting a cancellation keeps the order open and clears the request flag; reject is idempotent', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await paidOrder(buyer, 'key-can-0002', 1);
      const rid = (await http.post(`/demo/shops/${buyer.shopId}/aftersale/cancellations`).set('x-demo-session', buyer.token).send({ orderId: id, reason: 'CHANGED_MIND' }).expect(201)).body.request.id as string;
      const replay = await http.post(`/demo/shops/${buyer.shopId}/aftersale/cancellations`).set('x-demo-session', buyer.token).send({ orderId: id }).expect(201);
      expect(replay.body.request.id).toBe(rid); // asking twice returns the same request
      expect((await t.call('POST', `/return_refund/202309/cancellations/${rid}/reject`, a.accessToken, { body: { reject_reason: 'NOPE' } })).status).toBe(400);
      await t.call('POST', `/return_refund/202309/cancellations/${rid}/reject`, a.accessToken, { body: { reject_reason: 'ALREADY_SHIPPED', comment: 'packed' } }).expect(200);
      await t.call('POST', `/return_refund/202309/cancellations/${rid}/reject`, a.accessToken, { body: { reject_reason: 'ALREADY_SHIPPED' } }).expect(200);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('CANCELLATION_REQUEST_CANCELLED');
      expect(await prisma.order.findFirstOrThrow({ where: { externalId: id } })).toMatchObject({ status: 'AWAITING_SHIPMENT', buyerRequestedCancel: false });
      expect((await t.call('POST', `/return_refund/202309/cancellations/${rid}/approve`, a.accessToken, { body: {} })).status).toBe(400); // rejected requests cannot be approved
      expect(await prisma.aftersaleLine.count({ where: { requestId: (await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).id, active: true } })).toBe(0);
    });

    it('UNPAID and ON_HOLD buyer cancels are immediate and create NO aftersale record; a seller cancel of a paid order is recorded as CANCEL', async () => {
      const buyer = await t.buyerSession(0);
      const c1 = await t.checkout(buyer, [{ skuId: BAG, quantity: 1 }], 'key-can-0003').expect(201);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${c1.body.order.id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'x' }).expect(201);
      const c2 = await t.checkout(buyer, [{ skuId: BAG, quantity: 1 }], 'key-can-0004').expect(201);
      await t.pay(buyer, c2.body.order.id).expect(201);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${c2.body.order.id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'x' }).expect(201);
      expect(await prisma.aftersaleRequest.count()).toBe(0);
      const id = await paidOrder(buyer, 'key-can-0005', 1);
      const seller = await t.sellerSession(0);
      await http.post(`/demo/shops/${seller.shopId}/orders/${id}/cancel`).set('x-demo-session', seller.token).send({ reason: 'out of stock' }).expect(201);
      const rec = await prisma.aftersaleRequest.findFirstOrThrow();
      expect(rec).toMatchObject({ kind: 'CANCELLATION', type: 'CANCEL', status: 'CANCELLATION_REQUEST_SUCCESS', role: 'SELLER' });
    });

    it('search pages with an opaque cursor in both directions with no gaps and enforces the OAS page_size ranges', async () => {
      const a = await t.connect(0);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const buyer = await t.buyerSession(0, i % 3);
        const id = await paidOrder(buyer, `key-can-pg0${i}`, 1);
        ids.push((await http.post(`/demo/shops/${buyer.shopId}/aftersale/cancellations`).set('x-demo-session', buyer.token).send({ orderId: id }).expect(201)).body.request.id);
      }
      const crawl = async (order: 'ASC' | 'DESC') => {
        const seen: string[] = [];
        let token = '';
        do {
          const r = await t.call('POST', CAN_SEARCH, a.accessToken, { query: { page_size: '1', sort_order: order, ...(token ? { page_token: token } : {}) }, body: {} }).expect(200);
          seen.push(...r.body.data.cancellations.map((x: any) => x.cancel_id));
          token = r.body.data.next_page_token;
          expect(r.body.data.total_count).toBe(4);
        } while (token);
        return seen;
      };
      expect(await crawl('ASC')).toEqual(ids);
      expect(await crawl('DESC')).toEqual([...ids].reverse());
      const bad = async (path: string, query: Record<string, string>, body: unknown = {}) => {
        const r = await t.call('POST', path, a.accessToken, { query, body });
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      };
      await bad(RET_SEARCH, { page_size: '5' }); // returns: valid range [10-50]
      await bad(RET_SEARCH, { page_size: '51' });
      await bad(CAN_SEARCH, { page_size: '0' });
      await bad(RET_SEARCH, { page_size: '10' }, { arbitration_status: ['IN_PROGRESS'] });
      await bad(RET_SEARCH, { page_size: '10' }, { return_status: ['NOPE'] });
      await bad(CAN_SEARCH, { page_size: '10' }, { nope: 1 });
      await bad(CAN_SEARCH, { page_size: '10', page_token: 'garbage' });
    });
  });

  // ---------- isolation, scope, contract ----------
  describe('isolation, scopes and unsupported operations', () => {
    it('another shop cannot see, read records of, decide on or check eligibility of a request or order', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-iso-ret01', 1);
      const rid = (await askReturn(buyer, id, 1).expect(201)).body.request.id as string;
      expect((await t.call('POST', RET_SEARCH, b.accessToken, { query: { page_size: '10' }, body: {} }).expect(200)).body.data.return_orders).toEqual([]);
      expect((await t.call('POST', RET_SEARCH, a.accessToken, { query: { page_size: '10' }, body: { return_ids: [rid] } }).expect(200)).body.data.total_count).toBe(1);
      for (const [method, path, body] of [
        ['GET', `/return_refund/202309/returns/${rid}/records`, undefined],
        ['POST', `/return_refund/202309/returns/${rid}/approve`, {}],
        ['POST', `/return_refund/202309/returns/${rid}/reject`, { reject_reason: 'OTHER' }],
        ['POST', `/return_refund/202309/cancellations/${rid}/approve`, {}],
      ] as const) {
        const r = await t.call(method, path, b.accessToken, { body });
        expect(r.status).toBe(404);
        expect(r.body.simulator_fault.kind).toBe('aftersale_not_found');
      }
      expect((await t.call('GET', '/return_refund/202309/reject_reasons', b.accessToken, { query: { return_or_cancel_id: rid } })).status).toBe(404);
      expect((await t.call('GET', `/return_refund/202512/orders/${id}/aftersale_eligibility`, b.accessToken)).status).toBe(404);
      expect((await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: rid } })).status).toBe('RETURN_OR_REFUND_REQUEST_PENDING'); // untouched
      const reasons = await t.call('GET', '/return_refund/202309/reject_reasons', a.accessToken, { query: { return_or_cancel_id: rid } }).expect(200);
      expect(conformErrors('ops/return.reject_reasons.response.json', reasons.body)).toEqual([]);
      expect(reasons.body.data.reasons.length).toBeGreaterThan(0);
      const search = await t.call('POST', RET_SEARCH, a.accessToken, { query: { page_size: '10' }, body: {} }).expect(200);
      expect(conformErrors('ops/return.search.response.json', search.body)).toEqual([]);
      const item = search.body.data.return_orders[0];
      expect(item).toMatchObject({ return_id: rid, order_id: id, return_type: 'REFUND', role: 'BUYER' });
      expect(item.return_line_items[0].refund_amount.refund_total).toBe('99000');
    });

    it('needs the aftersale scopes; read scope cannot decide; the RMA 202604 version is not exposed', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-scope-0001', 1);
      const rid = (await askReturn(buyer, id, 1).expect(201)).body.request.id as string;
      await prisma.token.updateMany({ data: { scopes: ['sim.aftersale.read'] } });
      expect((await t.call('POST', RET_SEARCH, a.accessToken, { query: { page_size: '10' }, body: {} })).status).toBe(200);
      const denied = await t.call('POST', `/return_refund/202309/returns/${rid}/approve`, a.accessToken, { body: {} });
      expect(denied.status).toBe(403);
      expect(denied.body.simulator_fault.kind).toBe('missing_scope');
      await prisma.token.updateMany({ data: { scopes: ['sim.order.read'] } });
      expect((await t.call('POST', RET_SEARCH, a.accessToken, { query: { page_size: '10' }, body: {} })).status).toBe(403);
      // return.rma_202604 is unsupported: no route answers for it, and Search Returns stays the 202309 operation
      for (const path of ['/return_refund/202604/returns/search', '/return_refund/202604/rma/search']) {
        await http.post(path).send({}).expect(404);
        expect((await t.call('POST', path, a.accessToken, { query: { page_size: '10' }, body: {} })).status).toBe(404);
      }
      const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'manifest.json'), 'utf8'));
      expect(manifest.operations.find((o: any) => o.id === 'return.rma_202604').status).toBe('unsupported');
    });
  });

  // ---------- webhooks ----------
  describe('webhook events (transactional outbox)', () => {
    const subscribe = (token: string, topic: string) => t.call('PUT', HOOKS, token, { body: { event_type: topic, address: 'http://localhost:9/hook' } }).expect(200);

    it('every status change enqueues RETURN_STATUS_CHANGE / CANCELLATION_STATUS_CHANGE with the new status; a refused decision enqueues nothing', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken, 'RETURN_STATUS_CHANGE');
      await subscribe(a.accessToken, 'CANCELLATION_STATUS_CHANGE');
      const buyer = await t.buyerSession(0);
      const id = await deliveredOrder(buyer, 'key-hook-ret01', 1);
      const rid = (await askReturn(buyer, id, 1).expect(201)).body.request.id as string;
      await t.call('POST', `/return_refund/202309/returns/${rid}/approve`, a.accessToken, { body: { decision: 'APPROVE_REFUND' } }).expect(200);
      const jobs = await prisma.webhookJob.findMany({ where: { topic: 'RETURN_STATUS_CHANGE' }, orderBy: { createdAt: 'asc' } });
      expect(jobs.map((j) => (j.payload as any).data.return_status)).toEqual(['RETURN_OR_REFUND_REQUEST_PENDING', 'RETURN_OR_REFUND_REQUEST_SUCCESS']);
      expect((jobs[0].payload as any)).toMatchObject({ type: 12, shop_id: '7494000000000000001', data: { order_id: id, return_id: rid, return_type: 'REFUND' } });
      expect(conformErrors('webhook-envelope.json', jobs[0].payload)).toEqual([]);
      const before = await prisma.webhookJob.count();
      expect((await t.call('POST', `/return_refund/202309/returns/${rid}/approve`, a.accessToken, { body: { decision: 'APPROVE_RETURN' } })).status).toBe(400);
      expect(await prisma.webhookJob.count()).toBe(before); // the failed decision left nothing behind

      const id2 = await paidOrder(buyer, 'key-hook-can01', 1);
      const cid = (await http.post(`/demo/shops/${buyer.shopId}/aftersale/cancellations`).set('x-demo-session', buyer.token).send({ orderId: id2 }).expect(201)).body.request.id as string;
      await t.call('POST', `/return_refund/202309/cancellations/${cid}/approve`, a.accessToken, { body: {} }).expect(200);
      const cancelJobs = await prisma.webhookJob.findMany({ where: { topic: 'CANCELLATION_STATUS_CHANGE' }, orderBy: { createdAt: 'asc' } });
      expect(cancelJobs.map((j) => (j.payload as any).data.cancel_status)).toEqual(['CANCELLATION_REQUEST_PENDING', 'CANCELLATION_REQUEST_SUCCESS']);
    });
  });

  // ---------- reset ----------
  it('a shop reset and a full reset still work when aftersale rows exist', async () => {
    const buyer = await t.buyerSession(0);
    const id = await deliveredOrder(buyer, 'key-reset-aft1', 1);
    await askReturn(buyer, id, 1).expect(201);
    const reset = async (scope: string, shopId?: string) => {
      const prep = await http.post('/test-admin/reset/prepare').set(admin).send({ scope, ...(shopId ? { shopId } : {}) }).expect(201);
      return http.post('/test-admin/reset').set(admin).send({ scope, ...(shopId ? { shopId } : {}), confirmationToken: prep.body.confirmationToken });
    };
    expect((await reset('SHOP', shopAId)).status).toBe(201);
    expect(await prisma.aftersaleRequest.count()).toBe(0);
    const id2 = await deliveredOrder(await t.buyerSession(0), 'key-reset-aft2', 1);
    await askReturn(await t.buyerSession(0), id2, 1).expect(201);
    expect((await reset('ALL')).status).toBe(201);
    expect(await prisma.aftersaleRequest.count()).toBe(0);
  });
});
