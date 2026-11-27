import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_APP_SCOPES, SCOPE_AUTHORIZED_SHOPS } from '../src/oauth/scopes';
import { apiStringToSign, computeApiSignature } from '../src/tiktok/signature';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const SHOPS_PATH = '/authorization/202309/shops';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Phase 03: consent, authorization code, tokens, signed Get Authorized Shops', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let cfg: AppConfig;
  let appKey: string;
  let appSecret: string;
  let redirect: string;

  beforeAll(async () => {
    app = await createApp({ env: { SEED_APP_REDIRECT_URIS: 'http://localhost:5174/merchant/channels/tiktok-shop/callback,smartomni://oauth/tiktok,http://127.0.0.1:5174/merchant/channels/tiktok-shop/callback' } });
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    http = request(app.getHttpServer());
    appKey = cfg.seed.appKey;
    appSecret = cfg.seed.appSecret;
    redirect = cfg.seed.appRedirectUris[0];
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
  });

  // ---------- helpers ----------
  async function sellerSession(index = 0) {
    const ids = (await http.get('/demo/identities')).body;
    // index 0 = seeded shop A (Mộc Lan), index 1 = seeded shop B (Bát Tràng); the three fashion shops are not addressed by index
    const isA = (x: any) => x.shops.some((sh: any) => sh.name.includes('Mộc Lan'));
    const seller = index === 0 ? ids.sellers.find(isA) : ids.sellers.find((x: any) => x.shops.some((sh: any) => sh.name.includes('Bát Tràng')));
    const sess = (await http.post('/demo/sessions').send({ role: 'SELLER', email: seller.email, password: '123' }).expect(201)).body;
    return { token: sess.sessionToken as string, shopId: sess.shopId as string };
  }
  const consentBody = (decision: 'accept' | 'deny', state?: string, extra: Record<string, unknown> = {}) => ({ app_key: appKey, decision, ...(state !== undefined ? { state } : {}), ...extra });

  async function accept(session: { token: string }, state = 'st-123') {
    const res = await http.post('/demo/authorization/consent').set('x-demo-session', session.token).send(consentBody('accept', state)).expect(201);
    const url = new URL(res.body.redirectUrl);
    return { code: url.searchParams.get('code')!, url, state: url.searchParams.get('state') };
  }
  const exchange = (code: string, secret = appSecret) => http.get('/api/v2/token/get').query({ app_key: appKey, app_secret: secret, auth_code: code, grant_type: 'authorized_code' });
  const refresh = (rt: string) => http.get('/api/v2/token/refresh').query({ app_key: appKey, app_secret: appSecret, refresh_token: rt, grant_type: 'refresh_token' });

  async function connect(index = 0) {
    const session = await sellerSession(index);
    const { code } = await accept(session);
    const res = await exchange(code).expect(200);
    return { session, code, tokens: res.body.data as { access_token: string; refresh_token: string; open_id: string; granted_scopes: string[] } };
  }

  function signed(accessToken: string, opts: { timestamp?: number; extra?: Record<string, string>; secret?: string; tamper?: boolean; appKeyOverride?: string } = {}) {
    const q: Record<string, string> = { app_key: opts.appKeyOverride ?? appKey, timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)), ...(opts.extra ?? {}) };
    q.sign = computeApiSignature(opts.secret ?? appSecret, SHOPS_PATH, q, '');
    if (opts.tamper) q.sign = q.sign.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    return http.get(SHOPS_PATH).query(q).set('x-tts-access-token', accessToken).set('content-type', 'application/json');
  }
  const expectFault = (res: request.Response, status: number, kind: string) => {
    expect(res.status).toBe(status);
    expect(Number.isInteger(res.body.code)).toBe(true);
    expect(res.body.code).not.toBe(0);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.request_id).toEqual(expect.any(String));
    expect(res.body.simulator_fault).toMatchObject({ kind, documented_in_tiktok_contract: false });
  };

  // ---------- consent ----------
  describe('consent page API', () => {
    it('shows app, shop and scopes; redirect defaults to the registered URI', async () => {
      const s = await sellerSession();
      const r = await http.get('/demo/authorization/consent').query({ app_key: appKey, state: 'abc' }).set('x-demo-session', s.token).expect(200);
      expect(r.body.shop.id).toBe(s.shopId);
      expect(r.body.scopes).toEqual(cfg.seed.appScopes);
      expect(r.body.redirectUri).toBe(redirect);
      expect(r.body.app.name).toBeTruthy();
      expect(JSON.stringify(r.body)).not.toContain(appSecret);
    });

    it('requires a seller session (no session / buyer session rejected)', async () => {
      await http.get('/demo/authorization/consent').query({ app_key: appKey }).expect(401);
      await http.post('/demo/authorization/consent').send(consentBody('accept')).expect(401);
      const ids = (await http.get('/demo/identities')).body;
      const buyer = (await http.post('/demo/sessions').send({ role: 'BUYER', email: ids.buyers[0].email, password: '123' }).expect(201)).body;
      await http.get('/demo/authorization/consent').query({ app_key: appKey }).set('x-demo-session', buyer.sessionToken).expect(403);
      await http.post('/demo/authorization/consent').set('x-demo-session', buyer.sessionToken).send(consentBody('accept')).expect(403);
      expect(await prisma.authorizationCode.count()).toBe(0);
    });

    it('accept redirects to the registered URI with code and the state echoed exactly', async () => {
      const s = await sellerSession();
      const state = 'tenant-state/with space&x=y?z#frag%';
      const { url, code } = await accept(s, state);
      expect(`${url.origin}${url.pathname}`).toBe(new URL(redirect).origin + new URL(redirect).pathname);
      expect(url.searchParams.get('state')).toBe(state);
      expect(code).toMatch(/^sim_ac_/);
      expect(url.searchParams.get('error')).toBeNull();
      const row = await prisma.authorizationCode.findFirstOrThrow();
      expect(row.shopId).toBe(s.shopId); // shop comes from the session
      expect(row.codeHash).not.toBe(code); // only the hash is stored
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('deny redirects with error=access_denied and the state, and creates no code', async () => {
      const s = await sellerSession();
      const res = await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send(consentBody('deny', 'st-deny')).expect(201);
      const url = new URL(res.body.redirectUrl);
      expect(url.searchParams.get('error')).toBe('access_denied');
      expect(url.searchParams.get('state')).toBe('st-deny');
      expect(url.searchParams.get('code')).toBeNull();
      expect(res.body.redirectUrl.startsWith(redirect)).toBe(true);
      expect(await prisma.authorizationCode.count()).toBe(0);
    });

    it('accepts and denies the registered mobile redirect without changing the web default', async () => {
      const s = await sellerSession();
      const mobile = 'smartomni://oauth/tiktok';
      const query = { app_key: appKey, redirect_uri: mobile, state: 'mobile-state' };
      const context = await http.get('/demo/authorization/consent').query(query).set('x-demo-session', s.token).expect(200);
      expect(context.body.redirectUri).toBe(mobile);

      const accepted = await http.post('/demo/authorization/consent').set('x-demo-session', s.token)
        .send(consentBody('accept', query.state, { redirect_uri: mobile })).expect(201);
      const acceptedUrl = new URL(accepted.body.redirectUrl);
      expect(`${acceptedUrl.protocol}//${acceptedUrl.host}${acceptedUrl.pathname}`).toBe(mobile);
      expect(acceptedUrl.searchParams.get('code')).toMatch(/^sim_ac_/);
      expect(acceptedUrl.searchParams.get('state')).toBe(query.state);
      expect((await prisma.authorizationCode.findFirstOrThrow()).redirectUri).toBe(mobile);

      const denied = await http.post('/demo/authorization/consent').set('x-demo-session', s.token)
        .send(consentBody('deny', query.state, { redirect_uri: mobile })).expect(201);
      const deniedUrl = new URL(denied.body.redirectUrl);
      expect(`${deniedUrl.protocol}//${deniedUrl.host}${deniedUrl.pathname}`).toBe(mobile);
      expect(deniedUrl.searchParams.get('error')).toBe('access_denied');
      expect(deniedUrl.searchParams.get('state')).toBe(query.state);
      expect(deniedUrl.searchParams.has('code')).toBe(false);
      expect(await prisma.authorizationCode.count()).toBe(1);
    });

    it('rejects an unregistered redirect_uri (exact match only) and issues no code', async () => {
      const s = await sellerSession();
      for (const bad of ['https://evil.example/cb', `${redirect}/`, `${redirect}?x=1`, redirect.replace('localhost', 'localhost.evil.example'), 'smartomni://oauth/tiktok/', 'smartomni://oauth/tiktok?x=1', 'javascript:alert(1)']) {
        await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send(consentBody('accept', 's', { redirect_uri: bad })).expect(400);
        await http.get('/demo/authorization/consent').query({ app_key: appKey, redirect_uri: bad }).set('x-demo-session', s.token).expect(400);
      }
      await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send({ ...consentBody('accept'), app_key: 'nope' }).expect(400);
      expect(await prisma.authorizationCode.count()).toBe(0);
      // an explicit registered redirect_uri is accepted
      await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send(consentBody('accept', 's', { redirect_uri: redirect })).expect(201);
    });

    it('rejects an oversized or control-character state', async () => {
      const s = await sellerSession();
      await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send(consentBody('accept', 'x'.repeat(513))).expect(400);
      await http.post('/demo/authorization/consent').set('x-demo-session', s.token).send(consentBody('accept', 'a\nb')).expect(400);
    });
  });

  // ---------- token exchange ----------
  describe('token exchange (GET /api/v2/token/get)', () => {
    it('exchanges a code once and returns the provisional token shape', async () => {
      const s = await sellerSession();
      const { code } = await accept(s);
      const nowSec = Math.floor(Date.now() / 1000);
      const res = await exchange(code).expect(200);
      expect(res.body).toMatchObject({ code: 0, message: 'success', request_id: expect.any(String) });
      const d = res.body.data;
      expect(Object.keys(d).sort()).toEqual(['access_token', 'access_token_expire_in', 'granted_scopes', 'open_id', 'refresh_token', 'refresh_token_expire_in']);
      expect(d.granted_scopes.length).toBeGreaterThan(0);
      expect([...d.granted_scopes].sort()).toEqual([...DEFAULT_APP_SCOPES].sort());
      expect(d.access_token).toMatch(/^sim_at_/);
      expect(d.refresh_token).toMatch(/^sim_rt_/);
      expect(d.open_id).toBe('sim-seller-open-id-a');
      expect(Math.abs(d.access_token_expire_in - (nowSec + cfg.oauth.accessTokenTtlMs / 1000))).toBeLessThan(5); // absolute Unix seconds
      expect(d.refresh_token_expire_in).toBeGreaterThan(d.access_token_expire_in);
      // tokens are stored only as hashes
      const raw = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "Token"`));
      expect(raw).not.toContain(d.access_token);
      expect(raw).not.toContain(d.refresh_token);
    });

    it('code reuse is rejected', async () => {
      const s = await sellerSession();
      const { code } = await accept(s);
      await exchange(code).expect(200);
      expectFault(await exchange(code), 400, 'auth_code_used');
    });

    it('concurrent exchange of one code yields exactly one token', async () => {
      const s = await sellerSession();
      const { code } = await accept(s);
      const results = await Promise.all(Array.from({ length: 6 }, () => exchange(code)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((r) => r.status !== 200)) expectFault(r, 400, 'auth_code_used');
      expect(await prisma.token.count()).toBe(1);
    });

    it('an expired code is rejected', async () => {
      const s = await sellerSession();
      const { code } = await accept(s);
      const exp = await http.post('/test-admin/authorization-codes/expire').set(admin).send({ shopId: s.shopId }).expect(201);
      expect(exp.body.expired).toBe(1);
      expectFault(await exchange(code), 400, 'auth_code_expired');
      expect(await prisma.token.count()).toBe(0);
    });

    it('unknown code, wrong secret, unknown app_key and missing params are rejected', async () => {
      const s = await sellerSession();
      const { code } = await accept(s);
      expectFault(await exchange('sim_ac_does_not_exist'), 400, 'auth_code_invalid');
      expectFault(await exchange(code, 'wrong-secret'), 401, 'invalid_app_credentials');
      expectFault(await http.get('/api/v2/token/get').query({ app_key: 'nope', app_secret: appSecret, auth_code: code }), 401, 'invalid_app_credentials');
      expectFault(await http.get('/api/v2/token/get').query({ app_key: appKey, app_secret: appSecret }), 400, 'invalid_input');
      expectFault(await http.get('/api/v2/token/get').query({ app_key: appKey }), 400, 'invalid_input');
      // the failed attempts did not burn the code
      await exchange(code).expect(200);
    });

    it('a code issued to one shop yields a token for that shop only', async () => {
      const a = await connect(0);
      const b = await connect(1);
      expect(a.session.shopId).not.toBe(b.session.shopId);
      const rows = await prisma.token.findMany();
      expect(new Set(rows.map((r) => r.shopId)).size).toBe(2);
    });

    it('re-authorizing the same shop supersedes the previous tokens', async () => {
      const first = await connect(0);
      const second = await connect(0);
      expectFault(await signed(first.tokens.access_token), 401, 'authorization_revoked');
      await signed(second.tokens.access_token).expect(200);
    });
  });

  // ---------- refresh ----------
  describe('refresh (GET /api/v2/token/refresh)', () => {
    it('rotates both tokens; the old refresh and access tokens stop working', async () => {
      const { tokens } = await connect();
      const res = await refresh(tokens.refresh_token).expect(200);
      expect(res.body.data.refresh_token).not.toBe(tokens.refresh_token);
      expect(res.body.data.access_token).not.toBe(tokens.access_token);
      expect(res.body.data.open_id).toBe(tokens.open_id);
      expect(res.body.data.granted_scopes).toEqual((tokens as { granted_scopes?: string[] }).granted_scopes);
      expectFault(await refresh(tokens.refresh_token), 400, 'refresh_token_invalid');
      expectFault(await signed(tokens.access_token), 401, 'token_invalid');
      await signed(res.body.data.access_token).expect(200);
      expect(await prisma.token.count()).toBe(1);
    });

    it('an expired access token is rejected and a refresh restores access', async () => {
      const { tokens, session } = await connect();
      const list = (await http.get('/test-admin/tokens').query({ shopId: session.shopId }).set(admin).expect(200)).body.items;
      expect(list).toHaveLength(1);
      const exp = (await http.post(`/test-admin/tokens/${list[0].id}/expire-access`).set(admin).expect(201)).body;
      expect(exp.accessExpired).toBe(true);
      expect(exp.refreshExpired).toBe(false);
      expectFault(await signed(tokens.access_token), 401, 'token_expired');
      const res = await refresh(tokens.refresh_token).expect(200);
      await signed(res.body.data.access_token).expect(200);
    });

    it('an expired refresh token requires authorizing again', async () => {
      const { tokens, session } = await connect();
      const id = (await http.get('/test-admin/tokens').set(admin)).body.items[0].id;
      await http.post(`/test-admin/tokens/${id}/expire-refresh`).set(admin).expect(201);
      expectFault(await refresh(tokens.refresh_token), 400, 'refresh_token_expired');
      // the seller can authorize again
      const again = await accept(session);
      const res = await exchange(again.code).expect(200);
      await signed(res.body.data.access_token).expect(200);
    });

    it('a revoked authorization cannot refresh or call APIs', async () => {
      const { tokens } = await connect();
      const id = (await http.get('/test-admin/tokens').set(admin)).body.items[0].id;
      const rev = (await http.post(`/test-admin/tokens/${id}/revoke`).set(admin).expect(201)).body;
      expect(rev.status).toBe('REVOKED');
      expectFault(await refresh(tokens.refresh_token), 400, 'authorization_revoked');
      expectFault(await signed(tokens.access_token), 401, 'authorization_revoked');
    });

    it('concurrent refresh with one refresh token: exactly one winner, atomic rotation', async () => {
      const { tokens } = await connect();
      const results = await Promise.all(Array.from({ length: 8 }, () => refresh(tokens.refresh_token)));
      const ok = results.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      for (const r of results.filter((r) => r.status !== 200)) expectFault(r, 400, 'refresh_token_invalid');
      expect(await prisma.token.count()).toBe(1);
      const next = ok[0].body.data;
      await signed(next.access_token).expect(200);
      expectFault(await refresh(tokens.refresh_token), 400, 'refresh_token_invalid');
      await refresh(next.refresh_token).expect(200); // the winner's refresh token keeps working
    });

    it('rejects unknown refresh tokens, wrong secret, and a refresh token of another app', async () => {
      const { tokens } = await connect();
      expectFault(await refresh('sim_rt_nope'), 400, 'refresh_token_invalid');
      expectFault(await http.get('/api/v2/token/refresh').query({ app_key: appKey, app_secret: 'bad', refresh_token: tokens.refresh_token }), 401, 'invalid_app_credentials');
      const other = await prisma.app.create({ data: { appKey: 'other-app', appSecret: 'other-secret-fake', name: 'Other', redirectUris: [], scopes: [] } });
      expectFault(await http.get('/api/v2/token/refresh').query({ app_key: other.appKey, app_secret: other.appSecret, refresh_token: tokens.refresh_token }), 400, 'refresh_token_invalid');
    });
  });

  // ---------- Get Authorized Shops ----------
  describe('GET /authorization/202309/shops', () => {
    it('returns the token shop in the official shape, with no tenant or token fields', async () => {
      const a = await connect(0);
      const res = await signed(a.tokens.access_token).expect(200);
      expect(res.body).toMatchObject({ code: 0, message: 'Success', request_id: expect.any(String) });
      expect(res.body.data.shops).toHaveLength(1);
      const shop = res.body.data.shops[0];
      expect(Object.keys(shop).sort()).toEqual(['cipher', 'code', 'id', 'name', 'region', 'seller_type']);
      expect(shop).toMatchObject({ cipher: 'GCP_SIM_SHOP_A_FAKE_CIPHER', id: '7494000000000000001', code: 'SIMVN0001', region: 'VN', seller_type: 'LOCAL' });
      expect(/^[0-9]+$/.test(shop.id)).toBe(true);
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain('tenant');
      expect(JSON.stringify(res.body)).not.toContain(a.tokens.access_token);
    });

    it('token isolation: shop A token only sees shop A and cannot use shop B cipher', async () => {
      const a = await connect(0);
      const b = await connect(1);
      const shopA = (await signed(a.tokens.access_token).expect(200)).body.data.shops[0];
      const shopB = (await signed(b.tokens.access_token).expect(200)).body.data.shops[0];
      expect(shopA.id).not.toBe(shopB.id);
      expect(shopA.cipher).not.toBe(shopB.cipher);
      await signed(a.tokens.access_token, { extra: { shop_cipher: shopA.cipher } }).expect(200);
      expectFault(await signed(a.tokens.access_token, { extra: { shop_cipher: shopB.cipher } }), 403, 'shop_cipher_mismatch');
      expectFault(await signed(b.tokens.access_token, { extra: { shop_cipher: shopA.cipher } }), 403, 'shop_cipher_mismatch');
    });

    it('rejects a token that was not issued to the app_key used', async () => {
      const a = await connect(0);
      const other = await prisma.app.create({ data: { appKey: 'other-app', appSecret: 'other-secret-fake', name: 'Other', redirectUris: [], scopes: [] } });
      expectFault(await signed(a.tokens.access_token, { appKeyOverride: other.appKey, secret: other.appSecret }), 403, 'token_invalid');
    });

    it('missing scope is rejected after the scope is removed from the grant', async () => {
      const a = await connect(0);
      const id = (await http.get('/test-admin/tokens').set(admin)).body.items[0].id;
      await http.post(`/test-admin/tokens/${id}/remove-scope`).set(admin).send({ scope: 'not.held' }).expect(404);
      const view = (await http.post(`/test-admin/tokens/${id}/remove-scope`).set(admin).send({ scope: SCOPE_AUTHORIZED_SHOPS }).expect(201)).body;
      expect(view.scopes).not.toContain(SCOPE_AUTHORIZED_SHOPS);
      expectFault(await signed(a.tokens.access_token), 403, 'missing_scope');
      // another shop is unaffected
      const b = await connect(1);
      await signed(b.tokens.access_token).expect(200);
    });

    it('bad signature variants are rejected', async () => {
      const a = await connect(0);
      const t = a.tokens.access_token;
      expectFault(await signed(t, { tamper: true }), 401, 'bad_signature');
      expectFault(await signed(t, { secret: 'not-the-secret' }), 401, 'bad_signature');
      // query changed after signing
      const ts = String(Math.floor(Date.now() / 1000));
      const q = { app_key: appKey, timestamp: ts };
      const sign = computeApiSignature(appSecret, SHOPS_PATH, q, '');
      expectFault(await http.get(SHOPS_PATH).query({ ...q, shop_cipher: 'GCP_SIM_SHOP_A_FAKE_CIPHER', sign }).set('x-tts-access-token', t), 401, 'bad_signature');
      // signed for another path
      const wrongPath = computeApiSignature(appSecret, '/authorization/202309/other', q, '');
      expectFault(await http.get(SHOPS_PATH).query({ ...q, sign: wrongPath }).set('x-tts-access-token', t), 401, 'bad_signature');
      // missing params / header
      expectFault(await http.get(SHOPS_PATH).query({ app_key: appKey, timestamp: ts }).set('x-tts-access-token', t), 400, 'invalid_input');
      expectFault(await http.get(SHOPS_PATH).query({ ...q, sign }), 400, 'invalid_input');
      expectFault(await http.get(SHOPS_PATH).query({ ...q, sign, app_key: 'unknown' }).set('x-tts-access-token', t), 401, 'unknown_app_key');
      // repeated parameter is ambiguous
      expectFault(await http.get(`${SHOPS_PATH}?app_key=${appKey}&app_key=${appKey}&timestamp=${ts}&sign=${sign}`).set('x-tts-access-token', t), 400, 'invalid_input');
      // an access_token query parameter is excluded from the signature, but the header is what authenticates
      await signed(t, { extra: { access_token: 'ignored' } }).expect(200);
    });

    it('stale and future timestamps are rejected; non-numeric is invalid input', async () => {
      const a = await connect(0);
      const t = a.tokens.access_token;
      const now = Math.floor(Date.now() / 1000);
      const win = cfg.oauth.signatureWindowMs / 1000;
      expectFault(await signed(t, { timestamp: now - win - 60 }), 401, 'stale_timestamp');
      expectFault(await signed(t, { timestamp: now + win + 60 }), 401, 'stale_timestamp');
      await signed(t, { timestamp: now - 5 }).expect(200);
      const q: Record<string, string> = { app_key: appKey, timestamp: 'yesterday' };
      q.sign = computeApiSignature(appSecret, SHOPS_PATH, q, '');
      expectFault(await http.get(SHOPS_PATH).query(q).set('x-tts-access-token', t), 400, 'invalid_input');
    });

    it('the unknown access token is rejected', async () => {
      expectFault(await signed('sim_at_garbage'), 401, 'token_invalid');
    });

    it('shifting the BUSINESS clock does not change token or signature validity (AuthClock is separate)', async () => {
      const a = await connect(0);
      await http.put('/test-admin/clock').set(admin).send({ setTo: '2040-01-01T00:00:00.000Z', freeze: true }).expect(200);
      await signed(a.tokens.access_token).expect(200);
      await refresh(a.tokens.refresh_token).expect(200);
      await http.put('/test-admin/clock').set(admin).send({ reset: true }).expect(200);
    });

    it('wrong methods and unsupported TikTok-shaped paths stay a plain 404', async () => {
      await http.post(SHOPS_PATH).expect(404);
      await http.get('/api/v2/token/other').expect(404);
    });
  });

  // ---------- signing vectors from contracts ----------
  describe('signing vectors (contracts/signing/test-vectors.json)', () => {
    const file = join(__dirname, '..', '..', 'contracts', 'signing', 'test-vectors.json');
    it('reproduces every API vector exactly', () => {
      const vectors = JSON.parse(readFileSync(file, 'utf8')).api as { name: string; app_secret: string; path: string; query: Record<string, string>; body: string | null; string_to_sign: string; sign: string }[];
      expect(vectors.length).toBeGreaterThanOrEqual(5);
      for (const v of vectors) {
        expect(apiStringToSign(v.app_secret, v.path, v.query, v.body ?? '')).toBe(v.string_to_sign);
        expect(computeApiSignature(v.app_secret, v.path, v.query, v.body ?? '')).toBe(v.sign);
      }
    });
  });

  // ---------- redaction ----------
  describe('secrets never reach logs or list APIs', () => {
    it('HTTP logs contain no codes, tokens, app secret or signatures', async () => {
      const s = await sellerSession();
      const consent = await http.post('/demo/authorization/consent').set('x-demo-session', s.token).set('x-request-id', 'req-consent').send(consentBody('accept', 'st-redact')).expect(201);
      const code = new URL(consent.body.redirectUrl).searchParams.get('code')!;
      const ex = await exchange(code).set('x-request-id', 'req-exchange').expect(200);
      const t = ex.body.data;
      const sh = await signed(t.access_token).set('x-request-id', 'req-shops').expect(200);
      expect(sh.status).toBe(200);
      const rf = await refresh(t.refresh_token).set('x-request-id', 'req-refresh').expect(200);
      const t2 = rf.body.data;
      const q = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
      const sign = computeApiSignature(appSecret, SHOPS_PATH, q, '');
      await http.get(SHOPS_PATH).query({ ...q, sign }).set('x-tts-access-token', t2.access_token).set('x-request-id', 'req-sign').expect(200);
      await sleep(500);

      const raw = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "HttpRequestLog"`));
      for (const secret of [code, t.access_token, t.refresh_token, t2.access_token, t2.refresh_token, appSecret, sign, s.token]) {
        expect(raw).not.toContain(secret);
      }
      // still useful for debugging: request ids, paths and non-secret fields are there
      expect(raw).toContain('req-exchange');
      expect(raw).toContain('/api/v2/token/get');
      expect(raw).toContain('st-redact');
      const logs = (await http.get('/test-admin/http-logs').query({ requestId: 'req-exchange' }).set(admin)).body.items;
      expect(logs).toHaveLength(1);
      expect(logs[0].responseStatus).toBe(200);
      expect(logs[0].router).toBe('TIKTOK');
      expect(logs[0].responseBody).toContain('"code":0');
      const shopLog = (await http.get('/test-admin/http-logs').query({ requestId: 'req-shops' }).set(admin)).body.items[0];
      expect(shopLog.shopId).toBe(s.shopId);
    });

    it('error responses and failed attempts do not echo secrets either', async () => {
      const bad = await exchange('sim_ac_secretish_code', 'super-secret-wrong').set('x-request-id', 'req-bad');
      expect(JSON.stringify(bad.body)).not.toContain('super-secret-wrong');
      expect(JSON.stringify(bad.body)).not.toContain('sim_ac_secretish_code');
      await sleep(400);
      const raw = JSON.stringify(await prisma.$queryRawUnsafe(`SELECT * FROM "HttpRequestLog" WHERE "requestId" = 'req-bad'`));
      expect(raw).not.toContain('super-secret-wrong');
      expect(raw).not.toContain('sim_ac_secretish_code');
    });

    it('list/metadata APIs never expose tokens, hashes, or the app secret', async () => {
      const a = await connect(0);
      const bodies = [
        (await http.get('/test-admin/tokens').set(admin)).text,
        (await http.get('/test-admin/shops').set(admin)).text,
        (await http.get('/demo/identities')).text,
        (await http.get('/demo/authorization/consent').query({ app_key: appKey }).set('x-demo-session', a.session.token)).text,
      ];
      const hashes = (await prisma.token.findMany()).flatMap((t) => [t.accessTokenHash, t.refreshTokenHash]);
      for (const body of bodies) {
        for (const secret of [appSecret, a.tokens.access_token, a.tokens.refresh_token, ...hashes]) expect(body).not.toContain(secret);
        expect(body).not.toMatch(/accessTokenHash|refreshTokenHash|appSecret/);
      }
      await http.get('/test-admin/tokens').expect(401);
      await http.post('/test-admin/authorization-codes/expire').send({}).expect(401);
    });
  });

  // ---------- reset ----------
  describe('reset includes authorization data', () => {
    it('SHOP and ALL resets delete codes and tokens', async () => {
      const a = await connect(0);
      await connect(1);
      await accept(a.session); // leaves an unused code behind
      const plan = (await http.post('/test-admin/reset/prepare').set(admin).send({ scope: 'SHOP', shopId: a.session.shopId }).expect(201)).body;
      expect(plan.affects.tokens).toBe(1);
      expect(plan.affects.authorizationCodes).toBe(2);
      await http.post('/test-admin/reset').set(admin).send({ scope: 'SHOP', shopId: a.session.shopId, confirmationToken: plan.confirmationToken }).expect(201);
      expect(await prisma.authorizationCode.count({ where: { shopId: a.session.shopId } })).toBe(0);
      expect(await prisma.token.count()).toBe(1);
      const all = (await http.post('/test-admin/reset/prepare').set(admin).send({ scope: 'ALL' }).expect(201)).body;
      await http.post('/test-admin/reset').set(admin).send({ scope: 'ALL', confirmationToken: all.confirmationToken }).expect(201);
      expect(await prisma.authorizationCode.count()).toBe(0);
      expect(await prisma.token.count()).toBe(0);
    });
  });
});
