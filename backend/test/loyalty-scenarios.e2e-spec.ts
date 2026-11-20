import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const DAY = 24 * 3600 * 1000;

describe('Phase 09b (simulator side): loyalty test data generated with the business clock', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
    t = new TiktokTestClient(http, app.get(APP_CONFIG));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
  });

  it('creates orders on both sides of the 15-day boundary with real completion times; DELIVERED and ON_HOLD orders never complete', async () => {
    const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
    const realBefore = Date.now();
    const res = await http.post('/test-admin/scenarios/loyalty-orders').set(admin).send({ shopId: shop.id }).expect(201);
    const byLabel = (re: RegExp) => res.body.orders.find((o: any) => re.test(o.label));
    const completedMs = (o: any) => new Date(o.completedAt).getTime();

    const eligible = byLabel(/16 days ago/);
    const boundary = byLabel(/exactly 15/);
    const notYet = byLabel(/minus 1 hour/);
    expect(eligible.status).toBe('COMPLETED');
    expect(boundary.status).toBe('COMPLETED');
    expect(notYet.status).toBe('COMPLETED');
    expect(realBefore - completedMs(eligible)).toBeGreaterThanOrEqual(16 * DAY - 5000);
    expect(realBefore - completedMs(boundary)).toBeGreaterThanOrEqual(15 * DAY - 5000);
    expect(realBefore - completedMs(boundary)).toBeLessThan(15 * DAY + 60_000);
    expect(Date.now() - completedMs(notYet)).toBeLessThan(15 * DAY); // a claim now must still be refused by SmartOmni
    const delivered = byLabel(/delivered but not completed/);
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.completedAt).toBeNull();
    expect(byLabel(/on hold/).status).toBe('ON_HOLD');

    // money components stay separate: the claimable base is sub_total, not total_amount
    for (const o of res.body.orders) {
      expect(o.amountsVnd.shippingFee).toBeGreaterThan(0);
      expect(o.amountsVnd.total).toBe(o.amountsVnd.subTotal + o.amountsVnd.shippingFee + o.amountsVnd.tax);
      expect(o.amountsVnd.total).not.toBe(o.amountsVnd.subTotal);
    }
    // the API shows the same facts (source status + update_time), through the signed order detail
    const a = await t.connect(0);
    const detail = await t.call('GET', '/order/202507/orders', a.accessToken, { query: { ids: eligible.orderId } }).expect(200);
    const o = detail.body.data.orders[0];
    expect(o.status).toBe('COMPLETED');
    expect(o.update_time * 1000).toBe(Math.floor(completedMs(eligible) / 1000) * 1000);
    expect(o.payment.sub_total).toBe(String(eligible.amountsVnd.subTotal));
    expect(o.payment.total_amount).toBe(String(eligible.amountsVnd.total));
  });

  it('restores the business clock afterwards and leaves the request-signature clock alone', async () => {
    const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
    await http.post('/test-admin/scenarios/loyalty-orders').set(admin).send({ shopId: shop.id, thresholdDays: 3 }).expect(201);
    const clock = (await http.get('/test-admin/clock').set(admin).expect(200)).body;
    expect(clock.frozen).toBe(false);
    expect(Math.abs(new Date(clock.now).getTime() - Date.now())).toBeLessThan(5000);
    // signed calls still work (auth clock is real time)
    const a = await t.connect(0);
    await t.call('POST', '/order/202309/orders/search', a.accessToken, { query: { page_size: '10' }, body: {} }).expect(200);
  });

  it('requires the admin token and a known shop', async () => {
    await http.post('/test-admin/scenarios/loyalty-orders').send({ shopId: 'x' }).expect(401);
    await http.post('/test-admin/scenarios/loyalty-orders').set(admin).send({ shopId: 'does-not-exist' }).expect(404);
  });
});
