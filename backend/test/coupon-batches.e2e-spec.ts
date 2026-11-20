import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { CouponBatchService, CreateBatchInput } from '../src/coupons/coupon-batch.service';
import { PROMO_CODE_PATTERN } from '../src/coupons/coupon-rules';
import { cryptoRandomInt, generatePromoCode, PROMO_CODE_ALPHABET } from '../src/coupons/promo-code';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';
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
});
