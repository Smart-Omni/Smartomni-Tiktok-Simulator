import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { distributeProportionally, computeDiscount } from '../src/coupons/coupon-rules';
import { PrismaService } from '../src/prisma/prisma.service';
import { conformErrors } from './contract';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const SEARCH = '/promotion/202406/coupons/search';
const detailPath = (id: string) => `/promotion/202406/coupons/${id}`;
const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Phase 09a: coupons (read API, Seller data, checkout discount)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;

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
  });

  const SKU_WHITE = 'sim-sku-a-TEE-WHT-M'; // 129000
  const SKU_BLACK = 'sim-sku-a-TEE-BLK-M'; // 135000
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  function createCoupon(seller: { token: string; shopId: string }, over: Record<string, unknown> = {}) {
    const code = String((over.promoCode as string) ?? `CP${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
    return http.post(`/demo/shops/${seller.shopId}/coupons`).set('x-demo-session', seller.token).send({
      title: 'Test coupon',
      promoCode: code,
      discount: { type: 'AMOUNT_OFF', amountVnd: 20000 },
      endAt: iso(DAY),
      ...over,
    });
  }
  const checkout = (buyer: { token: string; shopId: string }, key: string, couponCode?: string, items = [{ skuId: SKU_WHITE, quantity: 2 }]) =>
    http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey: key, items, ...(couponCode ? { couponCode } : {}) });
  const advance = (ms: number) => http.put('/test-admin/clock').set(admin).send({ advanceMs: ms }).expect(200);

  // ---------- read API ----------
  describe('POST /promotion/202406/coupons/search and GET /promotion/202406/coupons/{id}', () => {
    it('conforms to the OAS-derived schemas and returns money as strings with the discount block of its type', async () => {
      const { accessToken, seller } = await t.connect(0);
      await createCoupon(seller, { title: 'Amount', promoCode: 'AMOUNT1000', discount: { type: 'AMOUNT_OFF', amountVnd: 20000 }, minSpendVnd: 100000, redemptionLimit: 5 }).then((r) => expect(r.status).toBe(201));
      const pct = await createCoupon(seller, { title: 'Percent', promoCode: 'PERCENT10', discount: { type: 'PERCENT_OFF', percentage: 10, maxDiscountVnd: 30000 } }).expect(201);
      const search = await t.call('POST', SEARCH, accessToken, { query: { page_size: '10' }, body: {} }).expect(200);
      expect(conformErrors('ops/promotion.coupon_search.response.json', search.body)).toEqual([]);
      expect(search.body.data.total_count).toBe(2);
      expect(search.body.data.next_page_token).toBe('');
      const [a, p] = search.body.data.coupons;
      expect(a).toMatchObject({
        title: 'Amount',
        status: 'ONGOING',
        promo_code: 'AMOUNT1000',
        product_scope: 'FULL_SHOP',
        discount: { type: 'AMOUNT_OFF', reduction_amount: { amount: '20000', currency: 'VND' } },
        threshold: { type: 'MIN_SPEND', min_spend: { amount: '100000', currency: 'VND' } },
        usage_limits: { redemption_limit: 5 },
      });
      expect(p.discount).toEqual({ type: 'PERCENT_OFF', percentage: '10', max_discount: { amount: '30000', currency: 'VND' } });
      expect(p.threshold).toEqual({ type: 'NONE' });
      const detail = await t.call('GET', detailPath(pct.body.id), accessToken).expect(200);
      expect(conformErrors('ops/promotion.coupon_detail.response.json', detail.body)).toEqual([]);
      expect(detail.body.data.coupon).toMatchObject({ id: pct.body.id, usage_stats: { redeemed_count: 0 }, display_channels: ['PRIVATE'] });
    });

    it('is limited to the token shop: another shop cannot list or read a coupon', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const mine = await createCoupon(a.seller).expect(201);
      expect((await t.call('POST', SEARCH, b.accessToken, { query: { page_size: '10' }, body: {} }).expect(200)).body.data.total_count).toBe(0);
      const foreign = await t.call('GET', detailPath(mine.body.id), b.accessToken);
      expect(foreign.status).toBe(404);
      expect(foreign.body.simulator_fault.kind).toBe('coupon_not_found');
    });

    it('pages with an opaque cursor (default page size 50) and filters by derived status, display type and title keyword', async () => {
      const { accessToken, seller } = await t.connect(0);
      for (let i = 0; i < 12; i++) await createCoupon(seller, { title: `Promo ${i}`, promoCode: `PAGE${String(i).padStart(4, '0')}` }).expect(201);
      const crawl = async (size: string) => {
        const seen: string[] = [];
        let token = '';
        do {
          const r = await t.call('POST', SEARCH, accessToken, { query: { page_size: size, ...(token ? { page_token: token } : {}) }, body: {} }).expect(200);
          seen.push(...r.body.data.coupons.map((c: any) => c.id));
          token = r.body.data.next_page_token;
          expect(r.body.data.total_count).toBe(12);
        } while (token);
        return seen;
      };
      const seen = await crawl('5');
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      const dflt = await t.call('POST', SEARCH, accessToken, { body: {} }).expect(200);
      expect(dflt.body.data.coupons).toHaveLength(12);

      await createCoupon(seller, { title: 'Future', promoCode: 'FUTURE0001', startAt: iso(2 * HOUR), endAt: iso(DAY) }).expect(201);
      const off = await createCoupon(seller, { title: 'Switched off', promoCode: 'SWITCHOFF1' }).expect(201);
      await http.patch(`/demo/shops/${seller.shopId}/coupons/${off.body.id}`).set('x-demo-session', seller.token).send({ deactivated: true }).expect(200);
      const by = async (status: string[]) => (await t.call('POST', SEARCH, accessToken, { query: { page_size: '100' }, body: { status } }).expect(200)).body.data.coupons.map((c: any) => c.title);
      expect(await by(['NOT_START'])).toEqual(['Future']);
      expect(await by(['DEACTIVATED'])).toEqual(['Switched off']);
      expect(await by(['EXPIRED'])).toEqual([]);
      expect(await by(['ONGOING'])).toHaveLength(12);
      await advance(25 * HOUR); // business clock only: everything created above has now expired
      expect(await by(['EXPIRED'])).toHaveLength(13);
      expect(await by(['ONGOING'])).toEqual([]);
      const kw = await t.call('POST', SEARCH, accessToken, { query: { page_size: '100' }, body: { title_keyword: 'Promo 7' } }).expect(200);
      expect(kw.body.data.coupons.map((c: any) => c.title)).toEqual(['Promo 7']);
      const dt = await t.call('POST', SEARCH, accessToken, { query: { page_size: '100' }, body: { display_type: ['REGULAR'] } }).expect(200);
      expect(dt.body.data.total_count).toBe(0);
    });

    it('rejects bad page_size, cursors, filters and unknown fields as invalid_input; needs the promotion scope and a valid signature', async () => {
      const a = await t.connect(0);
      const bad = async (query: Record<string, string>, body: unknown = {}) => {
        const r = await t.call('POST', SEARCH, a.accessToken, { query, body });
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      };
      await bad({ page_size: '0' });
      await bad({ page_size: '101' });
      await bad({ page_size: 'x' });
      await bad({ page_token: 'garbage' });
      await bad({}, { status: ['WHATEVER'] });
      await bad({}, { status: 'ONGOING' });
      await bad({}, { display_type: ['NOPE'] });
      await bad({}, { title_keyword: '' });
      await bad({}, { nope: 1 });
      expect((await t.call('POST', SEARCH, a.accessToken, { body: {}, secret: 'wrong' })).status).toBe(401);
      await prisma.token.updateMany({ data: { scopes: ['sim.order.read'] } });
      const r = await t.call('POST', SEARCH, a.accessToken, { body: {} });
      expect(r.status).toBe(403);
      expect(r.body.simulator_fault.kind).toBe('missing_scope');
      expect((await t.call('GET', detailPath('1'), a.accessToken)).status).toBe(403);
    });
  });

  // ---------- locked creation ----------
  describe('voucher creation stays locked on the TikTok router', () => {
    it('no signed POST/PUT/PATCH/DELETE to any promotion path other than search exists (plain 404), and the manifest keeps coupon_create unsupported', async () => {
      const a = await t.connect(0);
      const mine = await createCoupon(a.seller).expect(201);
      const body = { title: 'x', promo_code: 'ABCDEF', discount: { type: 'AMOUNT_OFF' } };
      for (const [method, path] of [
        ['POST', '/promotion/202406/coupons'],
        ['PUT', '/promotion/202406/coupons'],
        ['POST', '/promotion/202406/coupons/create'],
        ['PUT', detailPath(mine.body.id)],
        ['POST', detailPath(mine.body.id)],
        ['DELETE', detailPath(mine.body.id)],
        ['POST', '/promotion/202309/activities'],
        ['POST', '/promotion/202309/coupons'],
      ] as const) {
        const r = await t.call(method, path, a.accessToken, { body });
        expect([method, path, r.status]).toEqual([method, path, 404]);
        expect(r.body.simulator_fault).toBeUndefined(); // the plain Nest 404, not a pretend TikTok answer
      }
      // nothing was created or changed through those calls
      expect(await prisma.coupon.count()).toBe(1);
      const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'manifest.json'), 'utf8'));
      const op = manifest.operations.find((o: any) => o.id === 'promotion.coupon_create');
      expect(op.status).toBe('unsupported');
      expect(op.blocker).toMatch(/LOCKED/);
    });
  });

  // ---------- Seller / Buyer demo ----------
  describe('/demo coupons', () => {
    it('validates the Seller input, keeps promo codes unique per shop and lets only a seller write', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      await createCoupon(a.seller, { promoCode: 'SHARED0001' }).expect(201);
      expect((await createCoupon(a.seller, { promoCode: 'shared0001' })).status).toBe(409); // case-insensitive duplicate
      await createCoupon(b.seller, { promoCode: 'SHARED0001' }).expect(201); // same code in another shop is fine
      for (const over of [{ promoCode: 'short' }, { promoCode: 'has space1' }, { discount: { type: 'PERCENT_OFF', percentage: 0 } }, { discount: { type: 'PERCENT_OFF', percentage: 101 } }, { discount: { type: 'AMOUNT_OFF', amountVnd: 0 } }, { endAt: iso(-DAY), startAt: iso(0) }, { audience: 'REPEAT_CUSTOMERS' }]) {
        expect((await createCoupon(a.seller, over)).status).toBe(400);
      }
      const buyer = await t.buyerSession(0);
      expect((await createCoupon(buyer, { promoCode: 'BUYERMADE01' })).status).toBe(403);
      await http.get(`/demo/shops/${b.seller.shopId}/coupons`).set('x-demo-session', a.seller.token).expect(403);
      const mine = (await http.get(`/demo/shops/${a.seller.shopId}/coupons`).set('x-demo-session', a.seller.token).expect(200)).body.items;
      expect(mine).toHaveLength(1);
    });

    it('edits title/window/limit but never the code or discount, and refuses a limit below the redemptions already used', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const c = await createCoupon(seller, { promoCode: 'EDITME0001', redemptionLimit: 3 }).expect(201);
      await checkout(buyer, 'key-edit-0001', 'EDITME0001').expect(201);
      const patch = (body: object) => http.patch(`/demo/shops/${seller.shopId}/coupons/${c.body.id}`).set('x-demo-session', seller.token).send(body);
      expect((await patch({ redemptionLimit: 1 })).status).toBe(200);
      expect((await patch({ redemptionLimit: 1, title: 'ok' })).body.redeemedCount).toBe(1);
      expect((await patch({ promoCode: 'CHANGED0001' })).status).toBe(400); // unknown field is not accepted as a change; nothing to update
      expect((await patch({ redemptionLimit: null, endAt: iso(-DAY) })).status).toBe(400);
      expect((await prisma.coupon.findFirstOrThrow()).promoCode).toBe('EDITME0001');
    });

    it('the buyer sees only usable coupons: not expired, not exhausted, audience matching', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'USABLE0001' }).expect(201);
      await createCoupon(seller, { promoCode: 'NEWONLY001', audience: 'NEW' }).expect(201);
      await createCoupon(seller, { promoCode: 'FULL000001', redemptionLimit: 1 }).expect(201);
      await createCoupon(seller, { promoCode: 'LATER00001', startAt: iso(HOUR), endAt: iso(DAY) }).expect(201);
      const codes = async () => (await http.get(`/demo/shops/${buyer.shopId}/coupons`).set('x-demo-session', buyer.token).expect(200)).body.items.map((c: any) => c.promoCode).sort();
      expect(await codes()).toEqual(['FULL000001', 'NEWONLY001', 'USABLE0001']);
      await checkout(buyer, 'key-seen-00001', 'FULL000001').expect(201); // uses the last redemption and makes this buyer a returning one
      expect(await codes()).toEqual(['USABLE0001']);
      await http.get(`/demo/shops/${buyer.shopId}/coupons`).set('x-demo-session', (await t.sellerSession(1)).token).expect(403);
    });
  });

  // ---------- checkout ----------
  describe('checkout with a coupon', () => {
    const detail = async (token: string, id: string) => (await t.call('GET', '/order/202507/orders', token, { query: { ids: id } }).expect(200)).body.data.orders[0];

    it('puts the discount in seller_discount only: shipping and tax untouched, total consistent, per-line shares sum to the discount', async () => {
      const { accessToken, seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'PERCENT10X', discount: { type: 'PERCENT_OFF', percentage: 10 } }).expect(201);
      const res = await checkout(buyer, 'key-money-0001', 'percent10x', [{ skuId: SKU_WHITE, quantity: 2 }, { skuId: SKU_BLACK, quantity: 1 }]).expect(201);
      const productTotal = 2 * 129000 + 135000; // 393000
      expect(res.body.order.amounts).toMatchObject({ productTotalVnd: productTotal, sellerDiscountVnd: 39300, platformDiscountVnd: 0, subTotalVnd: productTotal - 39300, shippingFeeVnd: cfg.orders.shippingFeeVnd, taxVnd: 0 });
      expect(res.body.order.amounts.totalVnd).toBe(productTotal - 39300 + cfg.orders.shippingFeeVnd);
      const o = await detail(accessToken, res.body.order.id);
      expect(o.payment).toMatchObject({ original_total_product_price: '393000', seller_discount: '39300', sub_total: '353700', shipping_fee: String(cfg.orders.shippingFeeVnd), original_shipping_fee: String(cfg.orders.shippingFeeVnd), tax: '0', total_amount: String(353700 + cfg.orders.shippingFeeVnd) });
      const shares = o.line_items.map((l: any) => Number(l.seller_discount));
      expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(39300);
      expect(o.line_items.every((l: any) => Number.isInteger(Number(l.seller_discount)) && Number(l.sale_price) > 0)).toBe(true);
      const row = await prisma.coupon.findFirstOrThrow();
      expect(row.redeemedCount).toBe(1);
      expect(await prisma.couponUsage.count()).toBe(1);
    });

    it('applies the percentage cap, never discounts more than the subtotal, and rounds percentages down', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'CAPPED0001', discount: { type: 'PERCENT_OFF', percentage: 50, maxDiscountVnd: 10000 } }).expect(201);
      expect((await checkout(buyer, 'key-cap-000001', 'CAPPED0001').expect(201)).body.order.amounts.sellerDiscountVnd).toBe(10000);
      await createCoupon(seller, { promoCode: 'HUGE000001', discount: { type: 'AMOUNT_OFF', amountVnd: 2_000_000_000 } }).expect(201);
      const huge = (await checkout(buyer, 'key-huge-00001', 'HUGE000001', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]).expect(201)).body.order.amounts;
      expect(huge.sellerDiscountVnd).toBe(99000);
      expect(huge.subTotalVnd).toBe(0);
      expect(huge.totalVnd).toBe(cfg.orders.shippingFeeVnd); // shipping is still charged
      expect(computeDiscount({ discountType: 'PERCENT_OFF', amountOffVnd: null, percentage: 33, maxDiscountVnd: null }, 1001)).toBe(330);
    });

    it('refuses unknown, deactivated, not-started, expired, under-minimum and audience-mismatched coupons with stable codes and takes no redemption', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'LATER00001', startAt: iso(HOUR), endAt: iso(DAY) }).expect(201);
      await createCoupon(seller, { promoCode: 'SHORTLIVE1', endAt: iso(HOUR) }).expect(201);
      await createCoupon(seller, { promoCode: 'MINSPEND01', minSpendVnd: 500000 }).expect(201);
      const off = await createCoupon(seller, { promoCode: 'DEACT00001' }).expect(201);
      await http.patch(`/demo/shops/${seller.shopId}/coupons/${off.body.id}`).set('x-demo-session', seller.token).send({ deactivated: true }).expect(200);
      await createCoupon(seller, { promoCode: 'NEWONLY001', audience: 'NEW' }).expect(201);
      const code = async (couponCode: string, key: string) => {
        const r = await checkout(buyer, key, couponCode);
        expect(r.status).toBe(400);
        return r.body.code as string;
      };
      expect(await code('NOSUCHCODE', 'key-bad-000001')).toBe('coupon_not_found');
      expect(await code('LATER00001', 'key-bad-000002')).toBe('coupon_not_started');
      expect(await code('DEACT00001', 'key-bad-000003')).toBe('coupon_deactivated');
      expect(await code('MINSPEND01', 'key-bad-000004')).toBe('coupon_min_spend');
      await advance(2 * HOUR);
      expect(await code('SHORTLIVE1', 'key-bad-000005')).toBe('coupon_expired');
      await checkout(buyer, 'key-first-0001').expect(201); // an earlier order makes the buyer a returning customer
      expect(await code('NEWONLY001', 'key-bad-000007')).toBe('coupon_not_eligible');
      expect(await prisma.couponUsage.count()).toBe(0);
      expect((await prisma.coupon.aggregate({ _sum: { redeemedCount: true } }))._sum.redeemedCount).toBe(0);
      expect(await prisma.order.count()).toBe(1); // only the plain order exists: refused checkouts left no order and no reserved stock
    });

    it('a retry with the same checkoutKey (including two concurrent submits) uses the coupon once', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'ONCEONLY01', redemptionLimit: 5 }).expect(201);
      const [a, b] = await Promise.all([checkout(buyer, 'key-retry-0001', 'ONCEONLY01'), checkout(buyer, 'key-retry-0001', 'ONCEONLY01')]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.order.id).toBe(b.body.order.id);
      const again = await checkout(buyer, 'key-retry-0001', 'ONCEONLY01').expect(201);
      expect(again.body.replayed).toBe(true);
      expect((await prisma.coupon.findFirstOrThrow()).redeemedCount).toBe(1);
      expect(await prisma.couponUsage.count()).toBe(1);
      expect(await prisma.order.count()).toBe(1);
    });

    it('concurrent checkouts never exceed the redemption limit', async () => {
      const { seller } = await t.connect(0);
      await createCoupon(seller, { promoCode: 'LIMIT00002', redemptionLimit: 2 }).expect(201);
      const buyers = await Promise.all([0, 1, 2].map((i) => t.buyerSession(0, i)));
      const attempts = [...buyers, ...buyers].map((b, i) => checkout(b, `key-race-00${i}`, 'LIMIT00002', [{ skuId: 'sim-sku-a-BAG-NAT', quantity: 1 }]));
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400).every((r) => r.body.code === 'coupon_exhausted')).toBe(true);
      const row = await prisma.coupon.findFirstOrThrow();
      expect(row.redeemedCount).toBe(2);
      expect(await prisma.couponUsage.count()).toBe(2);
      expect(await prisma.order.count()).toBe(2);
    });

    it('cancelling before payment returns the redemption exactly once; after payment it stays used', async () => {
      const { seller } = await t.connect(0);
      const buyer = await t.buyerSession(0);
      await createCoupon(seller, { promoCode: 'GIVEBACK01', redemptionLimit: 3 }).expect(201);
      const unpaid = (await checkout(buyer, 'key-give-00001', 'GIVEBACK01').expect(201)).body.order.id;
      const paid = (await checkout(buyer, 'key-give-00002', 'GIVEBACK01').expect(201)).body.order.id;
      await t.pay(buyer, paid).expect(201);
      expect((await prisma.coupon.findFirstOrThrow()).redeemedCount).toBe(2);
      const cancel = (id: string) => http.post(`/demo/shops/${buyer.shopId}/orders/${id}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'x' }).expect(201);
      await cancel(unpaid);
      await cancel(unpaid); // repeated cancel
      expect((await prisma.coupon.findFirstOrThrow()).redeemedCount).toBe(1);
      // after payment the order is AWAITING_SHIPMENT: the seller cancels it (a buyer cancel would only be a request, DECISIONS H7)
      await http.post(`/demo/shops/${seller.shopId}/orders/${paid}/cancel`).set('x-demo-session', seller.token).send({ reason: 'x' }).expect(201);
      expect((await prisma.order.findFirstOrThrow({ where: { externalId: paid } })).status).toBe('CANCELLED');
      expect((await prisma.coupon.findFirstOrThrow()).redeemedCount).toBe(1);
      expect(await prisma.couponUsage.count()).toBe(1);
    });

    it('a coupon of another shop cannot be used', async () => {
      const b = await t.connect(1);
      await createCoupon(b.seller, { promoCode: 'OTHERSHOP1' }).expect(201);
      const buyerA = await t.buyerSession(0);
      const r = await checkout(buyerA, 'key-other-0001', 'OTHERSHOP1');
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('coupon_not_found');
    });
  });

  describe('discount maths', () => {
    it('distributes proportionally in integer VND with deterministic largest-remainder rounding', () => {
      expect(distributeProportionally(10, [1, 1, 1])).toEqual([4, 3, 3]);
      expect(distributeProportionally(10001, [129000, 129000, 135000]).reduce((a, b) => a + b, 0)).toBe(10001);
      expect(distributeProportionally(0, [1, 2])).toEqual([0, 0]);
      expect(distributeProportionally(5, [0, 0])).toEqual([0, 0]);
      const w = [135000, 129000, 129000];
      expect(distributeProportionally(39300, w)).toEqual(distributeProportionally(39300, w));
    });
  });
});
