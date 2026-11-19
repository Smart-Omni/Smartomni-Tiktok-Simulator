import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { conformErrors } from './contract';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const LIST = '/customer_service/202309/conversations';
const msgsPath = (id: string) => `${LIST}/${id}/messages`;
const detailPath = (id: string) => `/customer_service/202601/conversations/${id}`;
const HOOKS = '/event/202309/webhooks';
const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const textOf = (content: string): string => (JSON.parse(content) as { content: string }).content;

describe('Phase 08: conversations (customer-service API, demo chat, events)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let t: TiktokTestClient;
  let http: ReturnType<typeof request>;

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
  });

  const buyerSends = (b: { token: string; shopId: string }, text: string) => http.post(`/demo/shops/${b.shopId}/chat/messages`).set('x-demo-session', b.token).send({ text });
  const listAll = async (token: string, size = 20) => {
    const out: any[] = [];
    let page = '';
    do {
      const r = await t.call('GET', LIST, token, { query: { page_size: String(size), ...(page ? { page_token: page } : {}) } }).expect(200);
      out.push(...r.body.data.conversations);
      page = r.body.data.next_page_token;
    } while (page);
    return out;
  };
  const conversationByNick = async (token: string, nick: string) => (await listAll(token)).find((c) => c.participants.some((p: any) => p.nickname === nick));
  const jobs = (topic: string) => prisma.webhookJob.findMany({ where: { topic }, orderBy: { createdAt: 'asc' } });

  describe('Buyer -> API -> shop -> Buyer', () => {
    it('a buyer message appears in the API, a signed reply reaches the buyer, content is a JSON string', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0, 0);
      const name = (await http.get('/demo/me').set('x-demo-session', buyer.token).expect(200)).body.buyer.name as string;
      await buyerSends(buyer, 'Cho mình hỏi về đơn hàng 😀').expect(201);
      const mine = (await listAll(a.accessToken)).find((c) => c.participants.find((p: any) => p.role === 'BUYER' && p.nickname === name));
      expect(mine).toBeTruthy();
      const msgsBody = (await t.call('GET', msgsPath(mine.id), a.accessToken, { query: { page_size: '10', sort_order: 'ASC', sort_field: 'index' } }).expect(200)).body;
      const msgs = msgsBody.data.messages;
      expect(conformErrors('ops/cs.messages.response.json', msgsBody)).toEqual([]);
      const last = msgs[msgs.length - 1];
      expect(last).toMatchObject({ type: 'TEXT', sender: { role: 'BUYER' }, is_visible: true });
      expect(typeof last.content).toBe('string');
      expect(textOf(last.content)).toBe('Cho mình hỏi về đơn hàng 😀');
      const sent = await t.call('POST', msgsPath(mine.id), a.accessToken, { body: { type: 'TEXT', content: JSON.stringify({ content: 'Shop đã nhận yêu cầu của bạn.' }) } }).expect(200);
      expect(conformErrors('ops/cs.send_message_202309.response.json', sent.body)).toEqual([]);
      expect(sent.body.data.message_id).toMatch(/^\d+$/);
      const view = (await http.get(`/demo/shops/${buyer.shopId}/chat/conversations/${(await prisma.conversation.findFirstOrThrow({ where: { externalId: mine.id } })).id}/messages`).set('x-demo-session', buyer.token).expect(200)).body;
      const lastView = view.items[view.items.length - 1];
      expect(lastView).toMatchObject({ role: 'SHOP', text: 'Shop đã nhận yêu cầu của bạn.', id: sent.body.data.message_id });
    });

    it('list, messages and detail conform to the OAS-derived schemas; buyer user_id differs from im_user_id', async () => {
      const a = await t.connect(0);
      const list = (await t.call('GET', LIST, a.accessToken, { query: { page_size: '20' } }).expect(200)).body;
      expect(conformErrors('ops/cs.conversations.response.json', list)).toEqual([]);
      const first = list.data.conversations[0];
      const detail = (await t.call('GET', detailPath(first.id), a.accessToken).expect(200)).body;
      expect(conformErrors('ops/cs.conversation_detail.response.json', detail)).toEqual([]);
      const buyer = detail.data.conversation.participants.find((p: any) => p.role === 'BUYER');
      expect(buyer.user_id).not.toBe(buyer.im_user_id);
      expect(detail.data.conversation.participant_count).toBe(detail.data.conversation.participants.length);
      expect(first.latest_message).toBeTruthy();
    });

    it('pages conversations and messages without gaps or repeats, in both orders and by index or create_time', async () => {
      const a = await t.connect(0);
      const all = await listAll(a.accessToken, 1);
      expect(all).toHaveLength(3);
      expect(new Set(all.map((c) => c.id)).size).toBe(3);
      const conv = (await prisma.conversation.findFirstOrThrow({ where: { externalId: all[0].id } }));
      for (let i = 0; i < 24; i++) await http.post(`/test-admin/chat/conversations/${conv.id}/buyer-message`).set(admin).send({ text: `m${i}` }).expect(201);
      const crawl = async (order: 'ASC' | 'DESC', field: 'index' | 'create_time') => {
        const ids: string[] = [];
        let page = '';
        do {
          const r = await t.call('GET', msgsPath(conv.externalId), a.accessToken, { query: { page_size: '7', sort_order: order, sort_field: field, ...(page ? { page_token: page } : {}) } }).expect(200);
          ids.push(...r.body.data.messages.map((m: any) => m.id));
          page = r.body.data.next_page_token;
        } while (page);
        return ids;
      };
      const asc = await crawl('ASC', 'index');
      expect(new Set(asc).size).toBe(asc.length);
      expect(asc).toHaveLength(await prisma.chatMessage.count({ where: { conversationId: conv.id } }));
      expect(await crawl('DESC', 'index')).toEqual([...asc].reverse());
      expect(await crawl('ASC', 'create_time')).toHaveLength(asc.length);
      const idx = (await t.call('GET', msgsPath(conv.externalId), a.accessToken, { query: { page_size: '10', sort_order: 'ASC', sort_field: 'index' } }).expect(200)).body.data.messages.map((m: any) => Number(m.index));
      expect(idx).toEqual([...idx].sort((x, y) => x - y));
      const lastPage = await t.call('GET', msgsPath(conv.externalId), a.accessToken, { query: { page_size: '10' } }).expect(200);
      expect(lastPage.body.data.messages).toHaveLength(10);
    });

    it('validates paging parameters', async () => {
      const a = await t.connect(0);
      const bad = async (path: string, query: Record<string, string>) => {
        const r = await t.call('GET', path, a.accessToken, { query });
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      };
      const c = await prisma.conversation.findFirstOrThrow({ where: { shopId: (await t.sellerSession(0)).shopId } });
      await bad(LIST, {});
      await bad(LIST, { page_size: '21' });
      await bad(LIST, { page_size: '5', page_token: 'garbage' });
      await bad(msgsPath(c.externalId), {});
      await bad(msgsPath(c.externalId), { page_size: '11' });
      await bad(msgsPath(c.externalId), { page_size: '5', sort_order: 'UP' });
      await bad(msgsPath(c.externalId), { page_size: '5', sort_field: 'size' });
    });
  });

  describe('Send Message rules', () => {
    it('only TEXT is created; other documented types, unknown types and malformed content are refused', async () => {
      const a = await t.connect(0);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const send = (body: unknown) => t.call('POST', msgsPath(conv.id), a.accessToken, { body });
      for (const type of ['IMAGE', 'VIDEO', 'PRODUCT_CARD', 'ORDER_CARD', 'RETURN_REFUND_CARD', 'COUPON_CARD', 'LOGISTICS_CARD']) {
        const r = await send({ type, content: '{}' });
        expect(r.status).toBe(400);
        expect(r.body.message).toContain('TEXT only');
      }
      const before = await prisma.chatMessage.count();
      for (const body of [
        { type: 'STICKER', content: '{"content":"x"}' },
        { type: 'TEXT' },
        { type: 'TEXT', content: 'not json' },
        { type: 'TEXT', content: '{"content":"x","extra":1}' },
        { type: 'TEXT', content: '{"content":""}' },
        { type: 'TEXT', content: JSON.stringify({ content: 'x'.repeat(2001) }) },
        { type: 'TEXT', content: '["x"]' },
      ]) {
        const r = await send(body);
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
      expect(await prisma.chatMessage.count()).toBe(before);
      await send({ type: 'TEXT', content: JSON.stringify({ content: 'x'.repeat(2000) }) }).expect(200);
    });

    it('send version 202606 and image upload are supported per TikTok OpenAPI', async () => {
      const a = await t.connect(0);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const r606 = await t.call('POST', `/customer_service/202606/conversations/${conv.id}/messages`, a.accessToken, {
        body: { type: 'TEXT', content: JSON.stringify({ content: 'Xin chào bạn' }) },
      }).expect(200);
      expect(r606.body.code).toBe(0);
      expect(r606.body.data.message_id).toBeDefined();

      const up = await t.call('POST', '/customer_service/202309/images/upload', a.accessToken, {
        body: { image_data: 'test' },
      }).expect(200);
      expect(up.body.code).toBe(0);
      expect(up.body.data.url).toBeDefined();
    });

    it('a conversation with can_send_message=false refuses the shop and leaves no message or event behind', async () => {
      const a = await t.connect(0);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'NEW_MESSAGE', address: 'http://localhost:9/hook' } }).expect(200);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: conv.id } });
      await http.post(`/test-admin/chat/conversations/${row.id}/flags`).set(admin).send({ canSendMessage: false }).expect(201);
      const before = { m: await prisma.chatMessage.count(), j: (await jobs('NEW_MESSAGE')).length };
      const r = await t.call('POST', msgsPath(conv.id), a.accessToken, { body: { type: 'TEXT', content: '{"content":"hi"}' } });
      expect(r.status).toBe(400);
      expect(r.body.simulator_fault.kind).toBe('cannot_send_message');
      expect({ m: await prisma.chatMessage.count(), j: (await jobs('NEW_MESSAGE')).length }).toEqual(before);
      expect((await t.call('GET', LIST, a.accessToken, { query: { page_size: '20' } })).body.data.conversations.find((c: any) => c.id === conv.id).can_send_message).toBe(false);
      const seller = await t.sellerSession(0);
      await http.post(`/demo/shops/${seller.shopId}/chat/conversations/${row.id}/messages`).set('x-demo-session', seller.token).send({ text: 'hi' }).expect(400);
    });

    it('concurrent sends get distinct, increasing indexes', async () => {
      const a = await t.connect(0);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      await Promise.all(Array.from({ length: 8 }, (_, i) => t.call('POST', msgsPath(conv.id), a.accessToken, { body: { type: 'TEXT', content: JSON.stringify({ content: `c${i}` }) } }).expect(200)));
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: conv.id } });
      const indexes = (await prisma.chatMessage.findMany({ where: { conversationId: row.id }, orderBy: { index: 'asc' } })).map((m) => m.index);
      expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, i) => i + 1));
    });
  });

  describe('isolation and scopes', () => {
    it('another shop cannot read or answer a conversation, and sees only its own list', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const convA = await conversationByNick(a.accessToken, 'Trần Văn An');
      for (const call of [
        () => t.call('GET', msgsPath(convA.id), b.accessToken, { query: { page_size: '10' } }),
        () => t.call('GET', detailPath(convA.id), b.accessToken),
        () => t.call('POST', msgsPath(convA.id), b.accessToken, { body: { type: 'TEXT', content: '{"content":"x"}' } }),
      ]) {
        const r = await call();
        expect(r.status).toBe(404);
        expect(r.body.simulator_fault.kind).toBe('conversation_not_found');
      }
      const listB = await listAll(b.accessToken);
      expect(listB.length).toBe(await prisma.conversation.count({ where: { shopId: (await t.sellerSession(1)).shopId } }));
      expect(listB.some((c) => c.id === convA.id)).toBe(false);
      const sellerA = await t.sellerSession(0);
      const sellerB = await t.sellerSession(1);
      const rowA = await prisma.conversation.findFirstOrThrow({ where: { externalId: convA.id } });
      await http.get(`/demo/shops/${sellerA.shopId}/chat/conversations/${rowA.id}/messages`).set('x-demo-session', sellerB.token).expect(403);
      await http.get(`/demo/shops/${sellerB.shopId}/chat/conversations/${rowA.id}/messages`).set('x-demo-session', sellerB.token).expect(404);
    });

    it('a buyer sees only their own conversation', async () => {
      const b0 = await t.buyerSession(0, 0);
      const b1 = await t.buyerSession(0, 1);
      const name = (await http.get('/demo/me').set('x-demo-session', b0.token).expect(200)).body.buyer.name as string;
      await buyerSends(b0, 'tin nhắn của buyer 0').expect(201);
      const own = (await http.get(`/demo/shops/${b0.shopId}/chat/conversations`).set('x-demo-session', b0.token).expect(200)).body.items;
      expect(own.every((c: any) => c.buyerNickname === name)).toBe(true);
      expect(own).toHaveLength(1);
      await http.get(`/demo/shops/${b1.shopId}/chat/conversations/${own[0].id}/messages`).set('x-demo-session', b1.token).expect(403);
      await http.post(`/demo/shops/${b1.shopId}/chat/conversations/${own[0].id}/messages`).set('x-demo-session', b1.token).send({ text: 'xen vào' }).expect(403);
    });

    it('needs the conversation scopes and a valid signature', async () => {
      const a = await t.connect(0);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      await prisma.token.updateMany({ data: { scopes: ['sim.conversation.read'] } });
      expect((await t.call('GET', LIST, a.accessToken, { query: { page_size: '1' } })).status).toBe(200);
      const w = await t.call('POST', msgsPath(conv.id), a.accessToken, { body: { type: 'TEXT', content: '{"content":"x"}' } });
      expect(w.status).toBe(403);
      expect(w.body.simulator_fault.kind).toBe('missing_scope');
      await prisma.token.updateMany({ data: { scopes: ['sim.conversation.write'] } });
      expect((await t.call('GET', LIST, a.accessToken, { query: { page_size: '1' } })).status).toBe(403);
      expect((await t.call('GET', LIST, a.accessToken, { query: { page_size: '1' }, secret: 'wrong' })).status).toBe(401);
    });
  });

  describe('events (transactional outbox)', () => {
    const subscribe = (token: string, topic = 'NEW_MESSAGE') => t.call('PUT', HOOKS, token, { body: { event_type: topic, address: 'http://localhost:9/hook' } }).expect(200);

    it('every stored message enqueues one NEW_MESSAGE envelope with the message, conversation and sender', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken);
      const buyer = await t.buyerSession(0, 0);
      const sent = (await buyerSends(buyer, 'xin chào').expect(201)).body.message;
      const all = await jobs('NEW_MESSAGE');
      expect(all).toHaveLength(1);
      const env: any = all[0].payload;
      expect(conformErrors('webhook-envelope.json', env)).toEqual([]);
      expect(env.data).toMatchObject({ message_id: sent.id, type: 'TEXT', sender: { role: 'BUYER' }, index: String(sent.index) });
      expect(textOf(env.data.content)).toBe('xin chào');
      expect(all[0].appId).toBeTruthy();
    });

    it('suppressEvent loses the event; duplicateEvent repeats the SAME notification id; polling still sees the message', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: conv.id } });
      await http.post(`/test-admin/chat/conversations/${row.id}/buyer-message`).set(admin).send({ text: 'mất event', suppressEvent: true }).expect(201);
      expect(await jobs('NEW_MESSAGE')).toHaveLength(0);
      const polled = (await t.call('GET', msgsPath(conv.id), a.accessToken, { query: { page_size: '10' } }).expect(200)).body.data.messages;
      expect(polled.some((m: any) => textOf(m.content) === 'mất event')).toBe(true);
      await http.post(`/test-admin/chat/conversations/${row.id}/buyer-message`).set(admin).send({ text: 'event kép', duplicateEvent: true }).expect(201);
      const dup = await jobs('NEW_MESSAGE');
      expect(dup).toHaveLength(2);
      expect((dup[0].payload as any).tts_notification_id).toBe((dup[1].payload as any).tts_notification_id);
      expect(dup[1].replayOfId).toBe(dup[0].id);
    });

    it('NEW_CONVERSATION fires when an agent joins or leaves, and not for plain messages', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken, 'NEW_CONVERSATION');
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: conv.id } });
      await http.post(`/test-admin/chat/conversations/${row.id}/buyer-message`).set(admin).send({ text: 'hi' }).expect(201);
      expect(await jobs('NEW_CONVERSATION')).toHaveLength(0);
      await http.post(`/test-admin/chat/conversations/${row.id}/agent`).set(admin).send({ joined: true }).expect(201);
      await http.post(`/test-admin/chat/conversations/${row.id}/agent`).set(admin).send({ joined: false }).expect(201);
      const ev = await jobs('NEW_CONVERSATION');
      expect(ev.map((j) => (j.payload as any).data.participant_count)).toEqual([3, 2]);
      expect((await t.call('GET', detailPath(conv.id), a.accessToken).expect(200)).body.data.conversation.participant_count).toBe(2);
    });

    it('events carry the shop of the conversation only', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      await subscribe(a.accessToken);
      await subscribe(b.accessToken);
      const buyerB = await t.buyerSession(1, 0);
      await buyerSends(buyerB, 'cho shop B').expect(201);
      const all = await jobs('NEW_MESSAGE');
      expect(all).toHaveLength(1);
      expect((all[0].payload as any).shop_id).toBe('7494000000000000002');
    });
  });

  describe('failure behaviours of a send', () => {
    it('an injected HTTP error fails BEFORE any write: nothing is stored, nothing is emitted', async () => {
      const a = await t.connect(0);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'NEW_MESSAGE', address: 'http://localhost:9/hook' } }).expect(200);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      await http.post('/test-admin/faults').set(admin).send({ target: 'API', kind: 'HTTP_ERROR', pathMatch: '/customer_service/', remaining: 1, params: { status: 503 } }).expect(201);
      const before = await prisma.chatMessage.count();
      const r = await t.call('POST', msgsPath(conv.id), a.accessToken, { body: { type: 'TEXT', content: '{"content":"x"}' } });
      expect(r.status).toBe(503);
      expect(await prisma.chatMessage.count()).toBe(before);
      expect(await jobs('NEW_MESSAGE')).toHaveLength(0);
    });

    it('dropSendResponse: the sender sees a broken connection although the message and its event were committed (indeterminate send)', async () => {
      const a = await t.connect(0);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'NEW_MESSAGE', address: 'http://localhost:9/hook' } }).expect(200);
      const conv = await conversationByNick(a.accessToken, 'Trần Văn An');
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: conv.id } });
      await http.post(`/test-admin/chat/conversations/${row.id}/flags`).set(admin).send({ dropSendResponse: true }).expect(201);
      const before = await prisma.chatMessage.count({ where: { conversationId: row.id } });
      let failed = false;
      try {
        const r = await t.call('POST', msgsPath(conv.id), a.accessToken, { body: { type: 'TEXT', content: '{"content":"gửi mà không có phản hồi"}' } });
        failed = r.status !== 200 || !r.body?.data?.message_id;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(await prisma.chatMessage.count({ where: { conversationId: row.id } })).toBe(before + 1);
      expect(await jobs('NEW_MESSAGE')).toHaveLength(1);
    });
  });

  describe('test data: identity mismatch and complaint label', () => {
    it('seeded conversations include an unlinked TikTok identity that no buyer or order can be matched to', async () => {
      const a = await t.connect(0);
      const list = await listAll(a.accessToken);
      const buyers = await prisma.buyer.findMany({ select: { externalId: true } });
      const unknown = list.filter((c) => !buyers.some((b) => c.participants.some((p: any) => p.role === 'BUYER' && p.user_id === b.externalId)));
      expect(unknown).toHaveLength(1);
      const buyerP = unknown[0].participants.find((p: any) => p.role === 'BUYER');
      expect(buyerP.user_id).not.toBe(buyerP.im_user_id);
    });

    it('the Test Console can create an unlinked conversation; the complaint label is test data and never appears in the API', async () => {
      const a = await t.connect(0);
      const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
      const created = await http.post('/test-admin/chat/conversations').set(admin).send({ shopId: shop.id, unknownBuyerNickname: 'lạ_mặt', text: 'tôi muốn khiếu nại' }).expect(201);
      expect(created.body.identityKnown).toBe(false);
      const list = (await t.call('GET', LIST, a.accessToken, { query: { page_size: '20' } }).expect(200)).body;
      expect(JSON.stringify(list).toLowerCase()).not.toContain('complaint');
      const consoleView = (await http.get('/test-admin/chat/conversations').set(admin).expect(200)).body.items;
      expect(consoleView.filter((c: any) => c.complaintTestLabel)).toHaveLength(1); // the one seeded test label
      expect(consoleView.some((c: any) => c.buyerNickname === 'lạ_mặt' && !c.identityKnown)).toBe(true);
    });

    it('system messages marked invisible are hidden from the Seller chat but exposed with is_visible=false by the API', async () => {
      const a = await t.connect(0);
      const conv = await conversationByNick(a.accessToken, 'Phạm Quốc Bảo').catch(() => null);
      const complaint = (await listAll(a.accessToken)).find((c) => c.latest_message?.type === 'NOTIFICATION') ?? conv;
      expect(complaint).toBeTruthy();
      const api = (await t.call('GET', msgsPath(complaint.id), a.accessToken, { query: { page_size: '10', sort_order: 'ASC' } }).expect(200)).body.data.messages;
      expect(api.some((m: any) => m.type === 'NOTIFICATION' && m.is_visible === false)).toBe(true);
      const seller = await t.sellerSession(0);
      const row = await prisma.conversation.findFirstOrThrow({ where: { externalId: complaint.id } });
      const view = (await http.get(`/demo/shops/${seller.shopId}/chat/conversations/${row.id}/messages`).set('x-demo-session', seller.token).expect(200)).body.items;
      expect(view.every((m: any) => m.visible)).toBe(true);
    });

    it('seeding twice does not duplicate or rewrite conversations', async () => {
      const before = await prisma.chatMessage.count();
      await app.get(SeedService).seedAll();
      expect(await prisma.chatMessage.count()).toBe(before);
      expect(await prisma.conversation.count()).toBe(5);
    });

    it('the demo chat reports which message types are unsupported', async () => {
      const buyer = await t.buyerSession(0, 0);
      const r = (await http.get(`/demo/shops/${buyer.shopId}/chat/conversations`).set('x-demo-session', buyer.token).expect(200)).body;
      expect(r.supportedTypes).toEqual(['TEXT']);
      expect(r.unsupported).toContain('IMAGE');
    });
  });
});
