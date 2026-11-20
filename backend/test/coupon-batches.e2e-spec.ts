import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { CouponBatchService, CreateBatchInput } from '../src/coupons/coupon-batch.service';
import { PROMO_CODE_PATTERN } from '../src/coupons/coupon-rules';
import { cryptoRandomInt, generatePromoCode, PROMO_CODE_ALPHABET } from '../src/coupons/promo-code';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const DAY = 24 * 3_600_000;
const GENERATED = /^[A-HJ-NP-Z2-9]{10}$/;

describe('Phase 09c: voucher batches (single-use promo codes)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;
  let batches: CouponBatchService;
  let clock: PersistentBusinessClock;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    http = request(app.getHttpServer());
    t = new TiktokTestClient(http, cfg);
    batches = app.get(CouponBatchService);
    clock = app.get(PersistentBusinessClock);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
    await clock.reset();
    batches.rand = cryptoRandomInt;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const SKU_WHITE = 'sim-sku-a-TEE-WHT-M'; // 129000
  const input = (over: Partial<CreateBatchInput> = {}): CreateBatchInput => ({
    title: 'Loyalty Diamond 30%',
    discount: { type: 'PERCENT_OFF', percentage: 30 },
    endAt: new Date(clock.now().getTime() + DAY),
    quantity: 5,
    ...over,
  });
  const shopId = async () => (await t.sellerSession(0)).shopId;
  const checkout = (buyer: { token: string; shopId: string }, key: string, couponCode: string) =>
    http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey: key, items: [{ skuId: SKU_WHITE, quantity: 2 }], couponCode });
  const cancel = (buyer: { token: string; shopId: string }, id: string) =>
    http.post(`/demo/shops/${buyer.shopId}/orders/${id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'x' }).expect(201);

  describe('code generator', () => {
    it('makes 10-character codes from the 32-symbol alphabet that always pass the promo code rule', () => {
      expect(PROMO_CODE_ALPHABET).toHaveLength(32);
      expect(PROMO_CODE_ALPHABET).not.toMatch(/[0O1I]/);
      for (let i = 0; i < 200; i++) {
        const code = generatePromoCode();
        expect(code).toMatch(GENERATED);
        expect(code).toMatch(PROMO_CODE_PATTERN);
      }
      expect(generatePromoCode(() => 0)).toBe('AAAAAAAAAA');
    });
  });

  describe('CouponBatchService', () => {
    it('creates N distinct single-use codes sharing one batchId and the batch data', async () => {
      const shop = await shopId();
      const now = clock.now();
      const { batch, codes } = await batches.createBatch(shop, input({ quantity: 25, minSpendVnd: 100000 }), now);
      expect(codes).toHaveLength(25);
      expect(new Set(codes.map((c) => c.promoCode)).size).toBe(25);
      for (const c of codes) expect(c.promoCode).toMatch(GENERATED);
      const rows = await prisma.coupon.findMany({ where: { shopId: shop } });
      expect(rows).toHaveLength(25);
      for (const r of rows) {
        expect(r).toMatchObject({ batchId: batch.id, redemptionLimit: 1, redeemedCount: 0, title: 'Loyalty Diamond 30%', discountType: 'PERCENT_OFF', percentage: 30, minSpendVnd: 100000, audience: 'ALL', deactivated: false });
        expect(r.startAt).toEqual(now);
        expect(r.externalId).toMatch(/^7700\d{15}$/);
      }
      expect(batch).toMatchObject({ quantity: 25, redeemed: 0, status: 'ONGOING', title: 'Loyalty Diamond 30%' });
    });

    it('regenerates a code that collides with an existing code of the shop (a manual one) instead of failing', async () => {
      const shop = await shopId();
      const now = clock.now();
      await prisma.coupon.create({
        data: { id: 'manual-1', shopId: shop, externalId: '7700000000000000001', title: 'Manual', promoCode: 'AAAAAAAAAA', discountType: 'AMOUNT_OFF', amountOffVnd: 1000, startAt: now, endAt: new Date(now.getTime() + DAY), createdAt: now, updatedAt: now },
      });
      // the first 10 draws spell AAAAAAAAAA (taken), then real randomness
      let draws = 0;
      batches.rand = (max) => (draws++ < 10 ? 0 : cryptoRandomInt(max));
      const { codes } = await batches.createBatch(shop, input({ quantity: 3 }), now);
      expect(codes).toHaveLength(3);
      expect(codes.map((c) => c.promoCode)).not.toContain('AAAAAAAAAA');
      expect(await prisma.coupon.count({ where: { shopId: shop, promoCode: 'AAAAAAAAAA' } })).toBe(1);
    });

    it('two batches created concurrently in one shop never share a code', async () => {
      const shop = await shopId();
      const now = clock.now();
      const [a, b] = await Promise.all([batches.createBatch(shop, input({ quantity: 200 }), now), batches.createBatch(shop, input({ quantity: 200, title: 'Other' }), now)]);
      expect(a.batch.id).not.toBe(b.batch.id);
      expect(new Set([...a.codes, ...b.codes].map((c) => c.promoCode)).size).toBe(400);
      expect(await prisma.coupon.count({ where: { shopId: shop } })).toBe(400);
    });

    it('retries the whole transaction on a unique-code race and gives up after 3 attempts without leaving codes behind', async () => {
      const shop = await shopId();
      const race = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: Prisma.prismaVersion.client });
      const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(race());
      const ok = await batches.createBatch(shop, input({ quantity: 2 }), clock.now());
      expect(ok.codes).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockReset().mockRejectedValue(race());
      await expect(batches.createBatch(shop, input({ quantity: 2, title: 'Never' }), clock.now())).rejects.toMatchObject({ status: 409 });
      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockRestore();
      expect(await prisma.coupon.count({ where: { shopId: shop, title: 'Never' } })).toBe(0);
    });

    it('rejects a quantity outside 1-500 and an empty window', async () => {
      const shop = await shopId();
      const now = clock.now();
      for (const quantity of [0, 501, 2.5]) await expect(batches.createBatch(shop, input({ quantity }), now)).rejects.toMatchObject({ status: 400 });
      await expect(batches.createBatch(shop, input({ startAt: new Date(now.getTime() + DAY), endAt: now }), now)).rejects.toMatchObject({ status: 400 });
      expect(await prisma.coupon.count({ where: { shopId: shop } })).toBe(0);
    });

    it('lists, reads and deactivates batches; deactivating twice is harmless and an unknown batch counts 0', async () => {
      const shop = await shopId();
      const now = clock.now();
      const first = await batches.createBatch(shop, input({ quantity: 3, title: 'First' }), now);
      const second = await batches.createBatch(shop, input({ quantity: 2, title: 'Second', discount: { type: 'AMOUNT_OFF', amountVnd: 20000 } }), now);
      const list = await batches.listBatches(shop, now);
      expect(list.map((b) => [b.title, b.quantity])).toEqual([['Second', 2], ['First', 3]]);
      const detail = await batches.getBatch(shop, first.batch.id, now);
      expect(detail!.codes.map((c) => c.promoCode)).toEqual(first.codes.map((c) => c.promoCode));
      expect(detail!.codes.every((c) => c.status === 'ONGOING' && c.redeemedCount === 0)).toBe(true);
      expect(await batches.getBatch(shop, 'nope', now)).toBeNull();
      expect(await batches.getBatch((await t.sellerSession(1)).shopId, first.batch.id, now)).toBeNull();

      expect(await batches.deactivateBatch(shop, first.batch.id, now)).toBe(3);
      expect(await batches.deactivateBatch(shop, first.batch.id, now)).toBe(3);
      expect(await batches.deactivateBatch(shop, 'nope', now)).toBe(0);
      const after = await batches.getBatch(shop, first.batch.id, now);
      expect(after!.status).toBe('DEACTIVATED');
      expect(after!.codes.every((c) => c.status === 'DEACTIVATED')).toBe(true);
      expect((await batches.getBatch(shop, second.batch.id, now))!.status).toBe('ONGOING');
    });
  });

  describe('burning a batch code on cancel (Q8)', () => {
    it('an UNPAID cancel gives the redemption back AND deactivates the code, exactly once', async () => {
      const buyer = await t.buyerSession(0);
      const { batch, codes } = await batches.createBatch(buyer.shopId, input({ quantity: 2 }), clock.now());
      const code = codes[0].promoCode;
      const order = (await checkout(buyer, 'key-burn-00001', code).expect(201)).body.order.id;
      expect((await prisma.coupon.findFirstOrThrow({ where: { promoCode: code } })).redeemedCount).toBe(1);
      await cancel(buyer, order);
      const burned = await prisma.coupon.findFirstOrThrow({ where: { promoCode: code } });
      expect(burned).toMatchObject({ redeemedCount: 0, deactivated: true });
      expect(await prisma.couponUsage.count({ where: { couponId: burned.id } })).toBe(0);
      await cancel(buyer, order); // repeated cancel changes nothing
      expect(await prisma.coupon.findFirstOrThrow({ where: { promoCode: code } })).toEqual(burned);
      // the burned code cannot be used again; the other code of the batch is untouched
      const again = await checkout(buyer, 'key-burn-00002', code);
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('coupon_deactivated');
      expect(await prisma.coupon.findFirstOrThrow({ where: { promoCode: codes[1].promoCode } })).toMatchObject({ redeemedCount: 0, deactivated: false });
      expect((await batches.getBatch(buyer.shopId, batch.id, clock.now()))!.status).toBe('ONGOING');
    });

    it('a single voucher still gets its redemption back and is NOT deactivated (09a-5)', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await http
        .post(`/demo/shops/${seller.shopId}/coupons`)
        .set('x-demo-session', seller.token)
        .send({ title: 'Single', promoCode: 'SINGLE0001', discount: { type: 'AMOUNT_OFF', amountVnd: 20000 }, endAt: new Date(Date.now() + DAY).toISOString(), redemptionLimit: 3 })
        .expect(201);
      const before = await prisma.coupon.findFirstOrThrow({ where: { promoCode: 'SINGLE0001' } });
      const order = (await checkout(buyer, 'key-single-0001', 'SINGLE0001').expect(201)).body.order.id;
      await cancel(buyer, order);
      expect(await prisma.coupon.findFirstOrThrow({ where: { promoCode: 'SINGLE0001' } })).toMatchObject({ redeemedCount: 0, deactivated: false, updatedAt: before.updatedAt });
      await checkout(buyer, 'key-single-0002', 'SINGLE0001').expect(201);
    });

    it('a cancel after payment keeps the batch code used and active', async () => {
      const buyer = await t.buyerSession(0);
      const { codes } = await batches.createBatch(buyer.shopId, input({ quantity: 1 }), clock.now());
      const order = (await checkout(buyer, 'key-paid-00001', codes[0].promoCode).expect(201)).body.order.id;
      await t.pay(buyer, order).expect(201);
      await cancel(buyer, order);
      expect(await prisma.coupon.findFirstOrThrow({ where: { promoCode: codes[0].promoCode } })).toMatchObject({ redeemedCount: 1, deactivated: false });
      expect(await prisma.couponUsage.count()).toBe(1);
    });
  });

  describe('/demo coupon batches + TikTok Search/Get (Phase 2)', () => {
    const SEARCH = '/promotion/202406/coupons/search';
    const detailPath = (id: string) => `/promotion/202406/coupons/${id}`;
    type Session = { token: string; shopId: string };
    const createBatch = (seller: Session, over: Record<string, unknown> = {}) =>
      http
        .post(`/demo/shops/${seller.shopId}/coupon-batches`)
        .set('x-demo-session', seller.token)
        .send({ title: 'Loyalty Diamond 30%', discount: { type: 'PERCENT_OFF', percentage: 30 }, endAt: new Date(Date.now() + DAY).toISOString(), quantity: 3, ...over });
    const search = (accessToken: string, body: Record<string, unknown> = {}, query: Record<string, string> = { page_size: '100' }) =>
      t.call('POST', SEARCH, accessToken, { query, body }).expect(200);
    const getCoupon = async (accessToken: string, id: string) => (await t.call('GET', detailPath(id), accessToken).expect(200)).body.data.coupon;
    const batchDetail = async (seller: Session, id: string) => (await http.get(`/demo/shops/${seller.shopId}/coupon-batches/${id}`).set('x-demo-session', seller.token).expect(200)).body;

    it('SmartOmni pulls every code of a batch with Search (pages of 100, case-insensitive title keyword); Get shows a single-use private coupon without batchId', async () => {
      const { accessToken, seller } = await t.connect(0);
      const created = await createBatch(seller, { quantity: 150 }).expect(201);
      expect(created.body.codes).toHaveLength(150);
      expect(created.body.batch).toMatchObject({ title: 'Loyalty Diamond 30%', quantity: 150, redeemed: 0, status: 'ONGOING', discountText: '30% off' });
      await createBatch(seller, { title: 'Loyalty Silver 10%', discount: { type: 'PERCENT_OFF', percentage: 10 }, quantity: 2 }).expect(201);

      const seen: string[] = [];
      let token = '';
      let pages = 0;
      do {
        const r = await search(accessToken, { title_keyword: 'diamond' }, { page_size: '100', ...(token ? { page_token: token } : {}) });
        expect(r.body.data.total_count).toBe(150);
        seen.push(...r.body.data.coupons.map((c: any) => c.promo_code));
        token = r.body.data.next_page_token;
        pages++;
      } while (token);
      expect(pages).toBe(2);
      expect(seen).toHaveLength(150);
      expect(new Set(seen)).toEqual(new Set(created.body.codes.map((c: any) => c.promoCode)));

      const one = await getCoupon(accessToken, created.body.codes[0].id);
      expect(one).toMatchObject({ promo_code: created.body.codes[0].promoCode, usage_limits: { redemption_limit: 1 }, display_channels: ['PRIVATE'], creation_source: 'SELLER_CENTER', usage_stats: { redeemed_count: 0 } });
      expect(JSON.stringify(one)).not.toMatch(/batch/i);
      expect(JSON.stringify((await search(accessToken)).body)).not.toMatch(/batch/i);
    });

    it('a code is used once; an UNPAID cancel burns it (redeemed 0 + DEACTIVATED) and checkout then answers coupon_deactivated', async () => {
      const { accessToken, seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const buyer2 = await t.buyerSession(0, 1);
      const { codes } = (await createBatch(seller, { quantity: 2 }).expect(201)).body;
      const [used, burned] = codes;
      await checkout(buyer, 'key-p2-000001', used.promoCode).expect(201);
      expect((await getCoupon(accessToken, used.id)).usage_stats.redeemed_count).toBe(1);
      const reuse = await checkout(buyer2, 'key-p2-000002', used.promoCode);
      expect(reuse.status).toBe(400);
      expect(reuse.body.code).toBe('coupon_exhausted');

      const unpaid = (await checkout(buyer, 'key-p2-000003', burned.promoCode).expect(201)).body.order.id;
      await cancel(buyer, unpaid);
      expect(await getCoupon(accessToken, burned.id)).toMatchObject({ status: 'DEACTIVATED', usage_stats: { redeemed_count: 0 } });
      const again = await checkout(buyer2, 'key-p2-000004', burned.promoCode.toLowerCase());
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('coupon_deactivated');
    });

    it('batch codes are hidden from GET /coupons (buyer and seller) but a typed batch code still discounts the checkout', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await http
        .post(`/demo/shops/${seller.shopId}/coupons`)
        .set('x-demo-session', seller.token)
        .send({ title: 'Public', promoCode: 'PUBLIC0001', discount: { type: 'AMOUNT_OFF', amountVnd: 10000 }, endAt: new Date(Date.now() + DAY).toISOString() })
        .expect(201);
      const { codes } = (await createBatch(seller).expect(201)).body;
      const list = async (s: Session) => (await http.get(`/demo/shops/${s.shopId}/coupons`).set('x-demo-session', s.token).expect(200)).body.items.map((c: any) => c.promoCode);
      expect(await list(buyer)).toEqual(['PUBLIC0001']);
      expect(await list(seller)).toEqual(['PUBLIC0001']);
      await checkout(buyer, 'key-p2-000010', codes[0].promoCode).expect(201);
      const usage = await prisma.couponUsage.findFirstOrThrow({ include: { order: true } });
      // 2 x 129000 = 258000, 30% => 77400 (shipping and tax are never discounted)
      expect(usage.discountVnd).toBe(77400);
      expect(usage.order.sellerDiscount).toBe(77400);
    });

    it('deactivating a batch switches off every code (Search DEACTIVATED, checkout coupon_deactivated); repeat ok; unknown batch 404', async () => {
      const { accessToken, seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const { batch, codes } = (await createBatch(seller).expect(201)).body;
      const patch = (id: string, body: unknown) => http.patch(`/demo/shops/${seller.shopId}/coupon-batches/${id}`).set('x-demo-session', seller.token).send(body as object);
      const res = await patch(batch.id, { deactivated: true }).expect(200);
      expect(res.body.batch.status).toBe('DEACTIVATED');
      expect(res.body.codes.every((c: any) => c.status === 'DEACTIVATED')).toBe(true);
      await patch(batch.id, { deactivated: true }).expect(200);
      await patch(batch.id, { deactivated: false }).expect(400);
      await patch('unknown', { deactivated: true }).expect(404);
      const off = (await search(accessToken, { status: ['DEACTIVATED'] })).body.data.coupons.map((c: any) => c.promo_code);
      expect(off.sort()).toEqual(codes.map((c: any) => c.promoCode).sort());
      const r = await checkout(buyer, 'key-p2-000020', codes[0].promoCode);
      expect(r.body.code).toBe('coupon_deactivated');

      const list = await http.get(`/demo/shops/${seller.shopId}/coupon-batches`).set('x-demo-session', seller.token).expect(200);
      expect(list.body.items).toEqual([expect.objectContaining({ id: batch.id, status: 'DEACTIVATED', quantity: 3, redeemed: 0 })]);
      expect((await batchDetail(seller, batch.id)).codes.map((c: any) => c.promoCode)).toEqual(codes.map((c: any) => c.promoCode));
      await http.get(`/demo/shops/${seller.shopId}/coupon-batches/unknown`).set('x-demo-session', seller.token).expect(404);
    });

    it('a single code of a batch can still be switched off through PATCH /coupons/:couponId', async () => {
      const { seller } = await t.connect(0);
      const { batch, codes } = (await createBatch(seller).expect(201)).body;
      await http.patch(`/demo/shops/${seller.shopId}/coupons/${codes[0].id}`).set('x-demo-session', seller.token).send({ deactivated: true }).expect(200);
      const detail = await batchDetail(seller, batch.id);
      expect(detail.codes.map((c: any) => c.status)).toEqual(['DEACTIVATED', 'ONGOING', 'ONGOING']);
      expect(detail.batch.status).toBe('ONGOING');
    });

    it('validates the batch body: no promoCode/redemptionLimit, quantity 1-500', async () => {
      const { seller } = await t.connect(0);
      await createBatch(seller, { promoCode: 'MYCODE01' }).expect(400);
      await createBatch(seller, { redemptionLimit: 2 }).expect(400);
      await createBatch(seller, { quantity: 0 }).expect(400);
      await createBatch(seller, { quantity: 501 }).expect(400);
      expect((await createBatch(seller, { quantity: 500 }).expect(201)).body.codes).toHaveLength(500);
    });

    it('POST /coupons without promoCode generates a 10-character code; a bad typed code is still rejected', async () => {
      const { seller } = await t.connect(0);
      const post = (over: Record<string, unknown>) =>
        http
          .post(`/demo/shops/${seller.shopId}/coupons`)
          .set('x-demo-session', seller.token)
          .send({ title: 'Auto', discount: { type: 'AMOUNT_OFF', amountVnd: 10000 }, endAt: new Date(Date.now() + DAY).toISOString(), ...over });
      expect((await post({}).expect(201)).body.promoCode).toMatch(GENERATED);
      expect((await post({ promoCode: '' }).expect(201)).body.promoCode).toMatch(GENERATED);
      expect((await post({ promoCode: 'abc12345' }).expect(201)).body.promoCode).toBe('ABC12345');
      await post({ promoCode: 'ABC12345' }).expect(409);
      await post({ promoCode: 'bad!' }).expect(400);
    });

    it('a buyer or the seller of another shop cannot use the batch routes (403)', async () => {
      const { seller } = await t.connect(0);
      const other = await t.sellerSession(1);
      const buyer = await t.buyerSession(0);
      const { batch } = (await createBatch(seller).expect(201)).body;
      const body = { title: 'x', discount: { type: 'AMOUNT_OFF', amountVnd: 1 }, endAt: new Date(Date.now() + DAY).toISOString(), quantity: 1 };
      for (const s of [buyer, other]) {
        await http.get(`/demo/shops/${seller.shopId}/coupon-batches`).set('x-demo-session', s.token).expect(403);
        await http.get(`/demo/shops/${seller.shopId}/coupon-batches/${batch.id}`).set('x-demo-session', s.token).expect(403);
        await http.post(`/demo/shops/${seller.shopId}/coupon-batches`).set('x-demo-session', s.token).send(body).expect(403);
        await http.patch(`/demo/shops/${seller.shopId}/coupon-batches/${batch.id}`).set('x-demo-session', s.token).send({ deactivated: true }).expect(403);
      }
    });

    it('a SHOP reset deletes the batch codes too', async () => {
      const { seller } = await t.connect(0);
      await createBatch(seller, { quantity: 5 }).expect(201);
      const admin = { 'x-test-admin-token': ADMIN_TOKEN };
      const plan = (await http.post('/test-admin/reset/prepare').set(admin).send({ scope: 'SHOP', shopId: seller.shopId }).expect(201)).body;
      await http.post('/test-admin/reset').set(admin).send({ scope: 'SHOP', shopId: seller.shopId, confirmationToken: plan.confirmationToken }).expect(201);
      expect(await prisma.coupon.count({ where: { shopId: seller.shopId } })).toBe(0);
    });
  });

  describe('/test-admin loyalty vouchers + coupon overview (Phase 3)', () => {
    const admin = { 'x-test-admin-token': ADMIN_TOKEN };
    const scenario = (body: Record<string, unknown>) => http.post('/test-admin/scenarios/loyalty-vouchers').set(admin).send(body);
    const overview = (query: Record<string, string>) => http.get('/test-admin/coupons').set(admin).query(query);

    it('needs the admin token', async () => {
      const shop = await shopId();
      await http.post('/test-admin/scenarios/loyalty-vouchers').send({ shopId: shop }).expect(401);
      await http.get('/test-admin/coupons').expect(401);
    });

    it('creates Silver 10% / Platinum 20% / Diamond 30% batches that SmartOmni can pull with Search; every call creates new batches', async () => {
      const { accessToken, seller } = await t.connect(0);
      const r = await scenario({ shopId: seller.shopId, quantityPerTier: 4 }).expect(201);
      expect(r.body.batches.map((b: any) => [b.tier, b.title, b.percentage, b.codes.length])).toEqual([
        ['Silver', 'Loyalty Silver 10%', 10, 4],
        ['Platinum', 'Loyalty Platinum 20%', 20, 4],
        ['Diamond', 'Loyalty Diamond 30%', 30, 4],
      ]);
      const start = new Date(r.body.batches[0].startAt).getTime();
      expect(new Date(r.body.batches[0].endAt).getTime() - start).toBe(30 * DAY);
      const found = await t.call('POST', '/promotion/202406/coupons/search', accessToken, { query: { page_size: '100' }, body: { title_keyword: 'LOYALTY DIAMOND' } }).expect(200);
      expect(found.body.data.coupons.map((c: any) => c.promo_code).sort()).toEqual(r.body.batches[2].codes.map((c: any) => c.promoCode).sort());
      expect(found.body.data.coupons.every((c: any) => c.discount.percentage === '30')).toBe(true);

      await scenario({ shopId: seller.shopId, quantityPerTier: 1, validDays: 7, tiers: [{ name: 'Gold', percentage: 15, maxDiscountVnd: 50000 }] }).expect(201);
      expect(await prisma.coupon.count({ where: { shopId: seller.shopId } })).toBe(13);
      expect(await prisma.coupon.findFirstOrThrow({ where: { title: 'Loyalty Gold 15%' } })).toMatchObject({ percentage: 15, maxDiscountVnd: 50000, redemptionLimit: 1 });
    });

    it('rejects bad tiers and quantities (400) and an unknown shop (404)', async () => {
      const shop = await shopId();
      await scenario({ shopId: shop, tiers: [{ name: 'Bad', percentage: 0 }] }).expect(400);
      await scenario({ shopId: shop, tiers: [{ name: 'Bad', percentage: 101 }] }).expect(400);
      await scenario({ shopId: shop, quantityPerTier: 501 }).expect(400);
      await scenario({ shopId: shop, validDays: 0 }).expect(400);
      await scenario({ shopId: 'no-such-shop' }).expect(404);
      expect(await prisma.coupon.count()).toBe(0);
    });

    it('pages a 250-code batch with limit=100 into 3 pages without gaps or duplicates; bad limit/after answer 400', async () => {
      const shop = await shopId();
      const { batch } = await batches.createBatch(shop, input({ quantity: 250 }), clock.now());
      await batches.createBatch(shop, input({ quantity: 3, title: 'Other' }), clock.now());
      const seen: string[] = [];
      let after = '';
      let pages = 0;
      do {
        const r = await overview({ batchId: batch.id, limit: '100', ...(after ? { after } : {}) }).expect(200);
        expect(r.body.items.every((c: any) => c.batchId === batch.id)).toBe(true);
        seen.push(...r.body.items.map((c: any) => c.promoCode));
        after = r.body.next;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(250);
      expect(new Set(seen).size).toBe(250);
      expect((await overview({ shopId: shop }).expect(200)).body.items).toHaveLength(200);
      for (const limit of ['0', '501', 'x']) await overview({ limit }).expect(400);
      await overview({ after: 'abc' }).expect(400);
    });

    it('usages link a code to the order that used it', async () => {
      const buyer = await t.buyerSession(0);
      const { batch, codes } = await batches.createBatch(buyer.shopId, input({ quantity: 2 }), clock.now());
      const order = (await checkout(buyer, 'key-p3-000001', codes[1].promoCode).expect(201)).body.order.id;
      const items = (await overview({ batchId: batch.id }).expect(200)).body.items;
      expect(items.map((c: any) => c.usages)).toEqual([[], [{ orderId: order, discountVnd: 77400, at: expect.any(String) }]]);
      expect(items[1]).toMatchObject({ redeemedCount: 1, redemptionLimit: 1, status: 'ONGOING' });
    });
  });
});
