import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const HOOKS = '/event/202309/webhooks';
const SKU = 'sim-sku-a-BAG-NAT';
const MIGRATION = join(__dirname, '..', 'prisma', 'migrations', '20261126000000_drop_on_hold', 'migration.sql');

/**
 * DECISIONS H10/H11: an order that was ON_HOLD when the drop_on_hold migration ran becomes AWAITING_SHIPMENT without a package
 * (the transition listener never ran). The data part of the migration is replayed here on such a row, then the startup repair
 * must give it exactly one TO_FULFILL package so SmartOmni and the seller can ship it like any other paid order.
 */
describe('drop_on_hold migration: released orders get their package', () => {
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
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
  });

  /** A paid order put back into the pre-migration shape: status ON_HOLD, no package, lines not linked to a package. */
  async function legacyHeldOrder(key: string): Promise<string> {
    const buyer = await t.buyerSession(0);
    const c = await t.checkout(buyer, [{ skuId: SKU, quantity: 2 }], key).expect(201);
    const id = c.body.order.id as string;
    await t.pay(buyer, id).expect(201);
    const row = await prisma.order.findFirstOrThrow({ where: { externalId: id } });
    await prisma.package.deleteMany({ where: { orderId: row.id } });
    await prisma.$executeRaw`UPDATE "Order" SET "status" = 'ON_HOLD' WHERE id = ${row.id}`;
    await prisma.$executeRaw`UPDATE "OrderLine" SET "displayStatus" = 'ON_HOLD', "packageId" = NULL WHERE "orderId" = ${row.id}`;
    return id;
  }

  /** The data statements of the real migration file (the column drops already ran when the test DB was migrated). */
  async function runMigrationDataStatements() {
    const updates = readFileSync(MIGRATION, 'utf8').split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter((s) => s.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const sql of updates) await prisma.$executeRawUnsafe(sql);
  }

  it('the migration releases ON_HOLD rows; the repair creates one TO_FULFILL package, links the lines and emits PACKAGE_UPDATE once', async () => {
    const a = await t.connect(0);
    await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'PACKAGE_UPDATE', address: 'http://localhost:9/pkg' } }).expect(200);
    const id = await legacyHeldOrder('key-legacy-0001');
    await runMigrationDataStatements();
    const row = await prisma.order.findFirstOrThrow({ where: { externalId: id }, include: { lines: true } });
    expect(row.status).toBe('AWAITING_SHIPMENT');
    expect(row.lines.every((l) => l.displayStatus === 'AWAITING_SHIPMENT' && l.packageId === null)).toBe(true);
    expect(await prisma.package.count({ where: { orderId: row.id } })).toBe(0);
    const before = await prisma.webhookJob.count({ where: { topic: 'PACKAGE_UPDATE' } });

    const fulfillment = app.get(FulfillmentService);
    expect(await fulfillment.repairMissingPackages()).toEqual([id]);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { orderId: row.id } });
    expect(pkg).toMatchObject({ status: 'TO_FULFILL', trackingNumber: null });
    expect((await prisma.orderLine.findMany({ where: { orderId: row.id } })).every((l) => l.packageId === pkg.externalId)).toBe(true);
    const jobs = await prisma.webhookJob.findMany({ where: { topic: 'PACKAGE_UPDATE' }, orderBy: { createdAt: 'asc' } });
    expect(jobs).toHaveLength(before + 1);
    expect((jobs[jobs.length - 1].payload as any).data).toMatchObject({ order_id: id, package_id: pkg.externalId, package_status: 'TO_FULFILL' });

    // idempotent, also when two runs race
    expect(await fulfillment.repairMissingPackages()).toEqual([]);
    const [r1, r2] = await Promise.all([fulfillment.repairMissingPackages(), fulfillment.repairMissingPackages()]);
    expect([...r1, ...r2]).toEqual([]);
    expect(await prisma.package.count({ where: { orderId: row.id } })).toBe(1);
    expect(await prisma.webhookJob.count({ where: { topic: 'PACKAGE_UPDATE' } })).toBe(before + 1);
  });

  it('a repaired order shows its package and ships like any paid order; unpaid and cancelled orders are left alone', async () => {
    const a = await t.connect(0);
    const id = await legacyHeldOrder('key-legacy-0002');
    const buyer = await t.buyerSession(0);
    const unpaid = (await t.checkout(buyer, [{ skuId: SKU, quantity: 1 }], 'key-legacy-0003').expect(201)).body.order.id as string;
    await runMigrationDataStatements();
    expect(await app.get(FulfillmentService).repairMissingPackages()).toEqual([id]);
    expect(await prisma.package.count({ where: { order: { externalId: unpaid } } })).toBe(0);

    const view = (await http.get(`/demo/shops/${a.seller.shopId}/orders/${id}/fulfillment`).set('x-demo-session', a.seller.token).expect(200)).body;
    expect(view).toMatchObject({ orderStatus: 'AWAITING_SHIPMENT', canArrange: true, blockedReason: null, package: { status: 'TO_FULFILL' } });
    const arranged = (await http.post(`/demo/shops/${a.seller.shopId}/orders/${id}/arrange-shipment`).set('x-demo-session', a.seller.token).send({}).expect(201)).body;
    expect(arranged).toMatchObject({ orderStatus: 'AWAITING_COLLECTION', package: { status: 'PROCESSING' } });
    expect(await prisma.package.count({ where: { order: { externalId: id } } })).toBe(1);
  });
});
