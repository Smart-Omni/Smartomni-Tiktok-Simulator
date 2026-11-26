import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';
import request from 'supertest';
import { APP_CONFIG } from '../src/config/config';

const SKU = 'sim-sku-a-BAG-NAT'; // seeded 100
const ONLY_SECOND = 'sim-sku-a-BAG-NVY'; // seeded 30
const MIGRATION = join(__dirname, '..', 'prisma', 'migrations', '20261128000000_single_warehouse', 'migration.sql');

/** The statements of the real migration file; BEGIN/COMMIT are replaced by the test's own transaction. */
function migrationStatements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/--.*$/gm, '');
  // split on ";" but keep the DO $$ ... $$ block in one piece
  const parts = sql.split('$$').flatMap((chunk, i) => (i % 2 ? [`$$${chunk}$$`] : chunk.split(/(;)/)));
  const statements: string[] = [''];
  for (const p of parts) {
    if (p === ';') statements.push('');
    else statements[statements.length - 1] += p;
  }
  return statements.map((s) => s.trim()).filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
}

/** DECISIONS SW-2: a database with two warehouses per shop ends with one, and no stock or reservation is lost. */
describe('single_warehouse migration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let t: TiktokTestClient;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    t = new TiktokTestClient(request(app.getHttpServer()), app.get(APP_CONFIG));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
  });

  const migrate = () =>
    prisma.$transaction(
      async (tx) => {
        for (const s of migrationStatements()) await tx.$executeRawUnsafe(s);
      },
      { timeout: 60_000 },
    );

  /** Puts shop A back into the two-warehouse shape, with an open order reserved in the second warehouse. */
  async function legacyShop(secondQuantity: number) {
    await prisma.$executeRawUnsafe('DROP INDEX "Warehouse_shopId_key"');
    const shop = await prisma.shop.findFirstOrThrow({ where: { name: { contains: 'Mộc Lan' } } });
    const kept = await prisma.warehouse.findFirstOrThrow({ where: { shopId: shop.id } });
    const second = await prisma.warehouse.create({ data: { shopId: shop.id, code: 'WH-OLD', externalId: '7600999999999999999', name: 'Old', city: 'Huế' } });
    const sku = await prisma.sku.findFirstOrThrow({ where: { shopId: shop.id, externalId: SKU } });
    const moved = await prisma.sku.findFirstOrThrow({ where: { shopId: shop.id, externalId: ONLY_SECOND } });
    await prisma.inventoryLevel.create({ data: { skuId: sku.id, warehouseId: second.id, quantity: secondQuantity } });
    await prisma.inventoryLevel.updateMany({ where: { skuId: moved.id }, data: { warehouseId: second.id } });
    const buyer = await t.buyerSession(0);
    const order = (await t.checkout(buyer, [{ skuId: SKU, quantity: 2 }], 'key-merge-0001').expect(201)).body.order.id as string;
    await prisma.order.updateMany({ where: { externalId: order }, data: { warehouseId: second.id } });
    return { shop, kept, sku, moved, buyer, order };
  }

  it('adds the stock to the default warehouse, re-points orders and leaves one warehouse per shop', async () => {
    const { shop, kept, sku, moved, buyer, order } = await legacyShop(7);
    await migrate();

    expect(await prisma.warehouse.findMany({ where: { shopId: shop.id } })).toEqual([expect.objectContaining({ id: kept.id, isDefault: true })]);
    const levels = async (skuId: string) => (await prisma.inventoryLevel.findMany({ where: { skuId } })).map((l) => [l.warehouseId, l.quantity]);
    expect(await levels(sku.id)).toEqual([[kept.id, 105]]); // 100 - 2 reserved + 7
    expect(await levels(moved.id)).toEqual([[kept.id, 30]]); // stored only in the removed warehouse
    expect((await prisma.order.findFirstOrThrow({ where: { externalId: order } })).warehouseId).toBe(kept.id);
    expect(await prisma.inventoryChange.findFirstOrThrow({ where: { skuId: sku.id, note: 'single warehouse merge' } })).toMatchObject({ warehouseId: kept.id, before: 98, after: 105, source: 'ADMIN' });

    await request(app.getHttpServer()).post(`/demo/shops/${buyer.shopId}/orders/${order}/cancel`).set('x-demo-session', buyer.token).send({ reason: 'test' }).expect(201);
    expect(await levels(sku.id)).toEqual([[kept.id, 107]]);
    await expect(prisma.warehouse.create({ data: { shopId: shop.id, code: 'WH-X', externalId: '1', name: 'x', city: 'x' } })).rejects.toThrow();
  });

  it('stops without changing anything when a merged quantity would exceed 99999', async () => {
    const { shop, sku } = await legacyShop(99_999);
    await expect(migrate()).rejects.toThrow(/99999/);
    expect(await prisma.warehouse.count({ where: { shopId: shop.id } })).toBe(2);
    expect(await prisma.inventoryLevel.count({ where: { skuId: sku.id } })).toBe(2);
    // put the index back for the suites that follow
    await prisma.$executeRawUnsafe('DELETE FROM "InventoryLevel" WHERE "warehouseId" IN (SELECT id FROM "Warehouse" WHERE code = \'WH-OLD\')');
    await prisma.order.deleteMany({ where: { shopId: shop.id } });
    await prisma.inventoryChange.deleteMany({ where: { shopId: shop.id } });
    await prisma.warehouse.deleteMany({ where: { code: 'WH-OLD' } });
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "Warehouse_shopId_key" ON "Warehouse"("shopId")');
  });
});
