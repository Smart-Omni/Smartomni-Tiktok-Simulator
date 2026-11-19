import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { PrismaService } from '../src/prisma/prisma.service';
import { ResetService } from '../src/reset/reset.service';
import { SeedService } from '../src/seed/seed.service';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';

describe('seed and reset', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const admin = () => ({ 'x-test-admin-token': ADMIN_TOKEN });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await cleanDb(prisma);
  });

  it('seeds five VN shops (two demo, three fashion) with separate buyers, products/SKUs and warehouses', async () => {
    const summary = await app.get(SeedService).seedAll();
    expect(summary.shops).toBe(5);
    expect(summary.sellers).toBe(5);
    expect(summary.warehouses).toBe(10);
    expect(summary.buyers).toBe(11);
    expect(summary.skus).toBeGreaterThanOrEqual(8);
    // Fashion catalog: 150 products, each on a seeded leaf category with the 3 required attributes, no duplicates.
    const fashion = await prisma.product.findMany({ where: { externalProductId: { startsWith: 'shopee:' } } });
    expect(fashion).toHaveLength(150);
    expect(fashion.every((p) => p.categoryId && (p.productAttributes as unknown[]).length === 3)).toBe(true);
    const shops = await prisma.shop.findMany({ include: { buyers: true } });
    expect(shops.every((s) => s.region === 'VN' && s.currency === 'VND')).toBe(true);
    const buyerIds = shops.map((s) => s.buyers.map((b) => b.id));
    expect(buyerIds[0].some((id) => buyerIds[1].includes(id))).toBe(false);
    expect(new Set(shops.map((s) => s.tiktokShopId)).size).toBe(5);
  });

  it('is idempotent: repeated seeding keeps identical rows and ids and does not undo business changes', async () => {
    const seed = app.get(SeedService);
    const first = await seed.seedAll();
    const ids1 = (await prisma.sku.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    const inv = await prisma.inventoryLevel.findFirstOrThrow();
    await prisma.inventoryLevel.update({ where: { id: inv.id }, data: { quantity: 1 } });
    const second = await seed.seedAll();
    const third = await seed.seedAll();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const ids2 = (await prisma.sku.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    expect(ids2).toEqual(ids1);
    expect((await prisma.inventoryLevel.findUniqueOrThrow({ where: { id: inv.id } })).quantity).toBe(1);
  });

  it('concurrent seed runs do not duplicate rows', async () => {
    const seed = app.get(SeedService);
    const results = await Promise.allSettled([seed.seedAll(), seed.seedAll(), seed.seedAll()]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const summary = await seed.seedAll();
    expect(summary.shops).toBe(5);
    expect(summary.skus).toBe(await prisma.sku.count());
    expect(summary.buyers).toBe(11);
  });

  it('reset requires a prepared, scope-bound confirmation token', async () => {
    await app.get(SeedService).seedAll();
    const http = request(app.getHttpServer());
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'ALL' }).expect(400);
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'ALL', confirmationToken: 'not-a-valid-token' }).expect(403);

    const logsPlan = (await http.post('/test-admin/reset/prepare').set(admin()).send({ scope: 'LOGS' }).expect(201)).body;
    expect(logsPlan.description).toMatch(/request logs/i);
    // a token minted for LOGS must not authorise ALL
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'ALL', confirmationToken: logsPlan.confirmationToken }).expect(403);
    expect(await prisma.shop.count()).toBe(5);
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'LOGS', confirmationToken: logsPlan.confirmationToken }).expect(201);
    expect(await prisma.shop.count()).toBe(5);
  });

  it('SHOP reset only touches that shop and restores its baseline; ALL reseeds', async () => {
    await app.get(SeedService).seedAll();
    const [a, b] = await prisma.shop.findMany({ orderBy: { tiktokShopId: 'asc' } });
    await prisma.inventoryLevel.updateMany({ data: { quantity: 3 } });
    await prisma.webhookJob.create({ data: { shopId: a.id, topic: 't', payload: {}, targetUrl: 'http://x' } });
    await prisma.webhookJob.create({ data: { shopId: b.id, topic: 't', payload: {}, targetUrl: 'http://x' } });
    const http = request(app.getHttpServer());

    const plan = (await http.post('/test-admin/reset/prepare').set(admin()).send({ scope: 'SHOP', shopId: a.id }).expect(201)).body;
    // a token for shop A cannot reset shop B
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'SHOP', shopId: b.id, confirmationToken: plan.confirmationToken }).expect(403);
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'SHOP', shopId: a.id, confirmationToken: plan.confirmationToken }).expect(201);

    expect(await prisma.webhookJob.count({ where: { shopId: a.id } })).toBe(0);
    expect(await prisma.webhookJob.count({ where: { shopId: b.id } })).toBe(1);
    const aInv = await prisma.inventoryLevel.findMany({ where: { sku: { shopId: a.id } } });
    const bInv = await prisma.inventoryLevel.findMany({ where: { sku: { shopId: b.id } } });
    expect(aInv.length).toBeGreaterThan(0);
    expect(aInv.every((i) => i.quantity !== 3)).toBe(true);
    expect(bInv.every((i) => i.quantity === 3)).toBe(true);
    expect((await prisma.shop.findUniqueOrThrow({ where: { tiktokShopId: a.tiktokShopId } })).id).toBe(a.id);

    const all = (await http.post('/test-admin/reset/prepare').set(admin()).send({ scope: 'ALL' }).expect(201)).body;
    await http.post('/test-admin/reset').set(admin()).send({ scope: 'ALL', confirmationToken: all.confirmationToken }).expect(201);
    expect(await prisma.webhookJob.count()).toBe(0);
    expect((await app.get(SeedService).summary()).shops).toBe(5);
  });

  it('refuses to reset a database whose name does not look like the simulator DB', async () => {
    const bad = new ResetService(
      prisma,
      { databaseUrl: 'postgresql://u:p@db:5432/smartomni', testAdminToken: ADMIN_TOKEN, resetConfirmTtlMs: 1000 } as any,
      app.get(PersistentBusinessClock),
      app.get(SeedService),
    );
    await expect(bad.prepare('ALL')).rejects.toThrow(/simulator/);
    await expect(bad.execute('ALL', null, '1.abc')).rejects.toThrow(/simulator/);
  });
});
