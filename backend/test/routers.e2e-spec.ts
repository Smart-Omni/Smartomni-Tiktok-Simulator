import { INestApplication } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import request from 'supertest';
import { AuthClock } from '../src/clock/clock';
import { PrismaService } from '../src/prisma/prisma.service';
import { TiktokModule } from '../src/tiktok/tiktok.module';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };

describe('router separation, demo isolation, clocks, request log', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
  });

  describe('router separation', () => {
    it('TikTok module serves only the Phase 03/04 controllers and does not provide admin/demo/seed/reset services', () => {
      const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TiktokModule) as any[]).map((c) => c.name).sort();
      expect(controllers).toEqual(['AftersaleController', 'ConversationsController', 'CouponsController', 'EventsController', 'FulfillmentController', 'InventoryController', 'OrdersController', 'ProductsController', 'ShopsController', 'TokenController']);
      const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TiktokModule) as any[]).map((p) => p.name).sort();
      expect(providers).toEqual(['TiktokApiGuard', 'TiktokFaultMiddleware']);
      // only the token-lifecycle module and the fulfillment module (the ship-package write is a TikTok-contract operation) may be imported:
      // no Demo/TestAdmin/Seed/Reset/Clock-control wiring
      const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, TiktokModule) as any[]).map((m) => m.name);
      expect(imports).toEqual(['OAuthModule', 'ChatModule', 'FulfillmentModule', 'AftersaleModule']);
    });

    it('control endpoints exist only under /test-admin and demo endpoints only under /demo', async () => {
      for (const p of ['/seed', '/reset', '/clock', '/faults', '/status', '/sessions', '/identities', '/http-logs', '/webhooks']) {
        await http.get(p).set(admin).expect(404);
        await http.post(p).set(admin).send({}).expect(404);
      }
      for (const p of ['/tiktok/test-admin/seed', '/api/test-admin/seed', '/supply_chain/202309/shipments/1/confirm']) {
        await http.post(p).set(admin).send({}).expect(404);
      }
      // sanity: the real routes exist
      await http.post('/test-admin/seed').set(admin).expect(201);
      await http.get('/demo/identities').expect(200);
      await http.get('/health/live').expect(200);
    });

    it('test-admin and demo reject missing credentials', async () => {
      await http.post('/test-admin/seed').expect(401);
      await http.post('/test-admin/seed').set('x-test-admin-token', 'wrong-token-value-1234').expect(401);
      await http.get('/demo/me').expect(401);
      await http.get('/demo/me').set('x-demo-session', 'nope').expect(401);
    });

    it('fault injection applies to the TikTok router only and is controlled only via /test-admin', async () => {
      await http.post('/test-admin/faults').set(admin).send({ target: 'API', kind: 'HTTP_ERROR', params: { status: 503 }, remaining: 1 }).expect(201);
      await http.get('/demo/identities').expect(200); // demo unaffected
      await http.get('/health/live').expect(200);
      await http.get('/some/tiktok/shaped/path').expect(503); // consumed by TikTok router
      await http.get('/some/tiktok/shaped/path').expect(404); // rule exhausted, unsupported endpoint is a plain 404
    });
  });

  describe('demo sessions: two shops cannot read or modify each other', () => {
    it('a seller or buyer session only reaches its own shop', async () => {
      const ids = (await http.get('/demo/identities')).body;
      expect(ids.sellers).toHaveLength(5);
      const [sa, sb] = ids.sellers;
      const sessA = (await http.post('/demo/sessions').send({ role: 'SELLER', sellerId: sa.id }).expect(201)).body;
      const sessB = (await http.post('/demo/sessions').send({ role: 'SELLER', sellerId: sb.id }).expect(201)).body;
      const shopA = sessA.shopId;
      const shopB = sessB.shopId;
      expect(shopA).not.toBe(shopB);

      const own = await http.get(`/demo/shops/${shopA}/products`).set('x-demo-session', sessA.sessionToken).expect(200);
      expect(own.body.items.length).toBeGreaterThan(0);
      await http.get(`/demo/shops/${shopB}/products`).set('x-demo-session', sessA.sessionToken).expect(403);
      await http.get(`/demo/shops/${shopA}`).set('x-demo-session', sessB.sessionToken).expect(403);
      await http.get(`/demo/shops/${shopB}/buyers`).set('x-demo-session', sessA.sessionToken).expect(403);

      const buyerOfB = ids.buyers.find((b: any) => b.shopId === shopB);
      const buyerSess = (await http.post('/demo/sessions').send({ role: 'BUYER', buyerId: buyerOfB.id }).expect(201)).body;
      expect(buyerSess.shopId).toBe(shopB);
      await http.get(`/demo/shops/${shopA}/products`).set('x-demo-session', buyerSess.sessionToken).expect(403);
      await http.get(`/demo/shops/${shopB}/buyers`).set('x-demo-session', buyerSess.sessionToken).expect(403); // buyers cannot list buyers
      const me = (await http.get('/demo/me').set('x-demo-session', buyerSess.sessionToken).expect(200)).body;
      expect(me.shop.id).toBe(shopB);

      // seller A cannot open a session for shop B
      await http.post('/demo/sessions').send({ role: 'SELLER', sellerId: sa.id, shopId: shopB }).expect(400);

      // only the hash of the session token is stored
      const stored = await prisma.demoSession.findMany();
      expect(stored.some((s) => s.tokenHash === sessA.sessionToken)).toBe(false);
    });
  });

  describe('clocks', () => {
    it('business clock can be shifted/frozen/reset and never changes the auth clock', async () => {
      const auth = app.get(AuthClock);
      const before = (await http.get('/test-admin/clock').set(admin).expect(200)).body;
      expect(before.offsetMs).toBe(0);

      const target = '2030-01-01T00:00:00.000Z';
      const frozen = (await http.put('/test-admin/clock').set(admin).send({ setTo: target, freeze: true }).expect(200)).body;
      expect(frozen.now).toBe(target);
      expect(frozen.frozen).toBe(true);
      expect(Math.abs(auth.now().getTime() - Date.now())).toBeLessThan(1000); // auth clock untouched

      const adv = (await http.put('/test-admin/clock').set(admin).send({ advanceMs: 3_600_000 }).expect(200)).body;
      expect(adv.now).toBe('2030-01-01T01:00:00.000Z');

      // persisted: a fresh clock instance would load the same state
      const row = await prisma.clockState.findUniqueOrThrow({ where: { id: 1 } });
      expect(row.frozenAt?.toISOString()).toBe('2030-01-01T01:00:00.000Z');

      const reset = (await http.put('/test-admin/clock').set(admin).send({ reset: true }).expect(200)).body;
      expect(reset.frozen).toBe(false);
      expect(reset.offsetMs).toBe(0);
    });
  });

  describe('HTTP request log redaction and request-id filter', () => {
    it('stores requests with tokens/secrets redacted and finds them by request id', async () => {
      const rid = 'req-redaction-test-1';
      const res = await http
        .post('/test-admin/webhooks')
        .query({ access_token: 'QUERY-TOKEN-VALUE', sign: 'SIGNATURE-VALUE', page: '1' })
        .set({ ...admin, 'x-request-id': rid, authorization: 'Bearer HEADER-BEARER-VALUE', 'x-tts-access-token': 'TTS-HEADER-VALUE' })
        .send({ shopId: (await prisma.shop.findFirstOrThrow()).id, topic: 'T', targetUrl: 'http://receiver.local/x', payload: { access_token: 'BODY-TOKEN-VALUE', app_secret: 'BODY-SECRET-VALUE', note: 'visible' } })
        .expect(201);
      expect(res.headers['x-request-id']).toBe(rid);

      await new Promise((r) => setTimeout(r, 300)); // log is written after the response finishes
      const logs = (await http.get('/test-admin/http-logs').query({ requestId: rid }).set(admin).expect(200)).body.items;
      expect(logs).toHaveLength(1);
      const serialized = JSON.stringify(logs[0]);
      for (const secret of ['QUERY-TOKEN-VALUE', 'SIGNATURE-VALUE', 'HEADER-BEARER-VALUE', 'TTS-HEADER-VALUE', 'BODY-TOKEN-VALUE', 'BODY-SECRET-VALUE', ADMIN_TOKEN]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain('visible');
      expect(logs[0]).toMatchObject({ router: 'TEST_ADMIN', method: 'POST', responseStatus: 201 });

      // the same correlation id is on the webhook job
      const jobs = (await http.get('/test-admin/webhooks').query({ requestId: rid }).set(admin).expect(200)).body.items;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].requestId).toBe(rid);

      // raw DB rows contain no secrets either (raw SQL, bypasses any API filtering)
      const raw = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "HttpRequestLog"`));
      expect(raw).not.toContain('QUERY-TOKEN-VALUE');
      expect(raw).not.toContain('BODY-SECRET-VALUE');
    });

    it('demo session creation response is stored without the raw session token', async () => {
      const ids = (await http.get('/demo/identities')).body;
      const sess = (await http.post('/demo/sessions').set('x-request-id', 'req-demo-sess').send({ role: 'BUYER', buyerId: ids.buyers[0].id }).expect(201)).body;
      await new Promise((r) => setTimeout(r, 300));
      const raw = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "HttpRequestLog" WHERE "requestId" = 'req-demo-sess'`));
      expect(raw).toContain('req-demo-sess');
      expect(raw).not.toContain(sess.sessionToken);
    });

    it('does not log health probes and test-console polling reads', async () => {
      await http.get('/health/live').set('x-request-id', 'req-health').expect(200);
      await http.get('/test-admin/status').set(admin).set('x-request-id', 'req-status').expect(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.httpRequestLog.count({ where: { requestId: { in: ['req-health', 'req-status'] } } })).toBe(0);
    });
  });

  describe('health', () => {
    it('reports ready with database and writable media/pdf dirs', async () => {
      const r = await http.get('/health/ready').expect(200);
      expect(r.body.checks).toMatchObject({ database: 'up', media: 'writable', pdf: 'writable' });
    });
  });
});
