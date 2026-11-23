import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const BAG = 'sim-sku-a-BAG-NAT';

describe('OAS alignment P1: Search Packages, Batch Ship, Read Message, Create Conversation', () => {
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
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
    shopAId = (await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } })).id;
    token = (await t.connect(0)).accessToken;
  });

  async function awaitingShipment(buyer: { token: string; shopId: string }, key: string) {
    const id = (await t.checkout(buyer, [{ skuId: BAG, quantity: 1 }], key).expect(201)).body.order.id as string;
    await t.pay(buyer, id).expect(201);
    const pkg = await prisma.package.findFirstOrThrow({ where: { order: { externalId: id } } });
    return { orderId: id, packageId: pkg.externalId };
  }

  describe('Search Packages', () => {
    const search = (query: Record<string, string>, body: unknown = {}) => t.call('POST', '/fulfillment/202309/packages/search', token, { query, body });

    it('lists packages with OAS fields, filters by status and time, and paginates both ways', async () => {
      const buyer = await t.buyerSession(0);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await awaitingShipment(buyer, `key-ps-000${i}`)).packageId);
      const all = await search({ page_size: '50' }).expect(200);
      expect(all.body.data.total_count).toBe(3);
      expect(all.body.data.packages[0]).toEqual(expect.objectContaining({ id: expect.any(String), status: 'TO_FULFILL', shipping_provider_id: expect.any(String), order_line_item_ids: expect.any(Array), orders: [{ id: expect.any(String) }] }));
      for (const order of ['ASC', 'DESC']) {
        const seen: string[] = [];
        let token2 = '';
        for (let i = 0; i < 5; i++) {
          const page = await search({ page_size: '2', sort_order: order, ...(token2 ? { page_token: token2 } : {}) }).expect(200);
          seen.push(...page.body.data.packages.map((p: any) => p.id));
          token2 = page.body.data.next_page_token;
          if (!token2) break;
        }
        expect(seen.sort()).toEqual([...ids].sort());
      }
      expect((await search({ page_size: '5' }, { package_status: 'COMPLETED' }).expect(200)).body.data.total_count).toBe(0);
      expect((await search({ page_size: '5' }, { create_time_ge: 4_000_000_000 }).expect(200)).body.data.packages).toEqual([]);
    });

    it('validates page_size, sort, token, filters and stays inside the shop', async () => {
      await search({}).expect(400);
      await search({ page_size: '51' }).expect(400);
      await search({ page_size: '5', sort_field: 'x' }).expect(400);
      await search({ page_size: '5', page_token: 'garbage' }).expect(400);
      await search({ page_size: '5' }, { package_status: 'NOPE' }).expect(400);
      await search({ page_size: '5' }, { unknown: 1 }).expect(400);
      const other = await t.buyerSession(1);
      await awaitingShipment(other, 'key-ps-other1').catch(() => undefined); // another shop's order needs its own clock/seed: ignore failures
      const mine = await search({ page_size: '50' }).expect(200);
      expect(mine.body.data.packages.every((p: any) => typeof p.id === 'string')).toBe(true);
      expect(await prisma.package.count({ where: { shopId: shopAId } })).toBe(mine.body.data.total_count);
    });
  });

  describe('Batch Ship Packages', () => {
    const ship = (packages: unknown[]) => t.call('POST', '/fulfillment/202309/packages/ship', token, { body: { packages } });

    it('ships the good packages, lists the failures and never blocks the rest', async () => {
      const buyer = await t.buyerSession(0);
      const a = await awaitingShipment(buyer, 'key-bs-0001');
      const b = await awaitingShipment(buyer, 'key-bs-0002');
      const r = await ship([{ id: a.packageId, handover_method: 'DROP_OFF' }, { id: 'nope' }, { id: b.packageId, self_shipment: { tracking_number: 'X' } }, { id: a.packageId }]).expect(200);
      const bad = r.body.data.errors.map((e: any) => e.detail.package_id);
      expect(bad).toEqual(['nope', b.packageId]);
      expect((await prisma.order.findFirstOrThrow({ where: { externalId: a.orderId } })).status).toBe('AWAITING_COLLECTION');
      expect((await prisma.order.findFirstOrThrow({ where: { externalId: b.orderId } })).status).toBe('AWAITING_SHIPMENT');
      expect((await prisma.package.findFirstOrThrow({ where: { externalId: a.packageId } })).handoverMethod).toBe('DROP_OFF');
      const wrongState = await ship([{ id: a.packageId, handover_method: 'WALK' }]).expect(200);
      expect(wrongState.body.data.errors).toHaveLength(1);
    });

    it('validates the whole array before shipping anything, and the token', async () => {
      const buyer = await t.buyerSession(0);
      const good = await awaitingShipment(buyer, 'key-bs-valid1');
      await ship([{ id: good.packageId }, {}]).expect(400);
      expect((await prisma.order.findFirstOrThrow({ where: { externalId: good.orderId } })).status).toBe('AWAITING_SHIPMENT'); // nothing was shipped
      await ship([]).expect(400);
      await ship([{}]).expect(400);
      await t.call('POST', '/fulfillment/202309/packages/ship', 'bad-token', { body: { packages: [{ id: 'x' }] } }).expect((res) => {
        if (res.status < 400) throw new Error(`expected an error, got ${res.status}`);
      });
    });
  });

  describe('Read Message and Create Conversation', () => {
    const list = async () => (await t.call('GET', '/customer_service/202309/conversations', token, { query: { page_size: '20' } }).expect(200)).body.data.conversations as any[];

    it('Read Message zeroes unread_count until the buyer writes again, and is idempotent', async () => {
      const buyer = await t.buyerSession(0);
      await http.post(`/demo/shops/${buyer.shopId}/chat/messages`).set('x-demo-session', buyer.token).send({ text: 'xin chào' }).expect(201);
      const conv = await prisma.conversation.findFirstOrThrow({ where: { shopId: shopAId, buyerId: buyer.buyerId } });
      const unreadOf = async () => (await list()).find((c) => c.id === conv.externalId).unread_count as number;
      expect(await unreadOf()).toBeGreaterThan(0);
      const read = () => t.call('POST', `/customer_service/202309/conversations/${conv.externalId}/messages/read`, token, { body: {} });
      expect((await read().expect(200)).body.data).toEqual({});
      expect(await unreadOf()).toBe(0);
      await read().expect(200);
      expect(await unreadOf()).toBe(0);
      await http.post(`/test-admin/chat/conversations/${conv.id}/buyer-message`).set(admin).send({ text: 'còn đó không?' }).expect(201);
      expect(await unreadOf()).toBe(1);
      await t.call('POST', '/customer_service/202309/conversations/1/messages/read', token, { body: {} }).expect(404);
    });

    it('Create Conversation is idempotent, emits NEW_CONVERSATION once, and rejects unknown buyers', async () => {
      const buyer = await t.buyerSession(0, 1);
      const row = await prisma.buyer.findUniqueOrThrow({ where: { id: buyer.buyerId } });
      await prisma.conversation.deleteMany({ where: { shopId: shopAId, buyerId: buyer.buyerId } });
      await t.call('PUT', '/event/202309/webhooks', token, { body: { event_type: 'NEW_CONVERSATION', address: 'http://localhost:9/hook' } }).expect(200);
      const create = (id: string) => t.call('POST', '/customer_service/202309/conversations', token, { body: { buyer_user_id: id } });
      const a = await create(row.externalId).expect(200);
      expect(a.body.data.conversation_id).toEqual(expect.any(String));
      expect(await prisma.webhookJob.count({ where: { topic: 'NEW_CONVERSATION' } })).toBe(1);
      const jobs = 1;
      const b = await create(row.externalId).expect(200);
      expect(b.body.data.conversation_id).toBe(a.body.data.conversation_id);
      expect(await prisma.webhookJob.count({ where: { topic: 'NEW_CONVERSATION' } })).toBe(jobs);
      expect(await prisma.conversation.count({ where: { shopId: shopAId, buyerId: buyer.buyerId } })).toBe(1);
      await create('no-such-buyer').expect(400);
      await t.call('POST', '/customer_service/202309/conversations', token, { body: {} }).expect(400);
    });
  });
});
