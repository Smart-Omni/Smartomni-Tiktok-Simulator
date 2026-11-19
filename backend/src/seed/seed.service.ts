import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { seedConversations } from '../chat/conversation-seed';
import { Prisma } from '@prisma/client';
import { SEED_SCENARIOS, SEED_SHOPS, SeedProduct, SeedShop, detId, numericId } from './seed-data';

/** Simulator-generated shop code (the `code` field of Get Authorized Shops); same rule as the Phase 03 migration backfill. */
export const shopCode = (tiktokShopId: string): string => `SIMVN${tiktokShopId.slice(-4)}`;

export interface SeedSummary {
  shops: number;
  sellers: number;
  buyers: number;
  warehouses: number;
  products: number;
  skus: number;
  inventoryLevels: number;
  scenarios: number;
  apps: number;
}

/** A fashion shop seeds ~400 SKUs in one transaction; Prisma's 5s default is too short on slow disks or a cold start. */
const SEED_TX_OPTIONS = { maxWait: 30_000, timeout: 180_000 };

/** Listing columns for a seeded product (create-only, so a re-seed never overwrites later edits). */
function listingData(p: SeedProduct): Partial<Prisma.ProductUncheckedCreateInput> {
  const l = p.listing;
  if (!l) return {};
  return {
    categoryId: l.categoryId,
    brandId: l.brandId,
    mainImages: (l.mainImages ?? []) as Prisma.InputJsonValue,
    packageWeight: l.packageWeight as Prisma.InputJsonValue | undefined,
    productAttributes: (l.productAttributes ?? []) as Prisma.InputJsonValue,
    isCodAllowed: l.isCodAllowed ?? false,
    externalProductId: l.externalProductId,
  };
}

/**
 * Deterministic, idempotent seed. Every row has a stable id derived from a name and is written with
 * upsert, so running it N times yields the same rows. Business quantities (inventory) are only created,
 * never overwritten, so a seed re-run does not undo test activity; use reset to restore the baseline.
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async seedAll(): Promise<SeedSummary> {
    await this.seedApp();
    await this.prisma.clockState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    for (const shop of SEED_SHOPS) await this.seedShop(shop);
    return this.summary();
  }

  async seedShopByTiktokId(tiktokShopId: string): Promise<void> {
    const shop = SEED_SHOPS.find((s) => s.tiktokShopId === tiktokShopId);
    if (shop) await this.seedShop(shop);
  }

  async seedApp(): Promise<void> {
    const { appKey, appSecret, appRedirectUris, appScopes } = this.config.seed;
    await this.prisma.app.upsert({
      where: { appKey },
      create: {
        id: detId('app:smartomni'),
        appKey,
        appSecret,
        name: 'SmartOmni (dev)',
        redirectUris: appRedirectUris,
        // Simulator-defined PLACEHOLDER scopes (the contract has no official scope names); from config, never TikTok scope names.
        scopes: appScopes,
      },
      update: { appSecret, redirectUris: appRedirectUris, scopes: appScopes },
    });
  }

  async seedShop(def: SeedShop): Promise<void> {
    const sellerId = detId(`seller:${def.key}`);
    const shopId = detId(`shop:${def.key}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.seller.upsert({
        where: { openId: def.seller.openId },
        create: { id: sellerId, ...def.seller },
        update: { name: def.seller.name, email: def.seller.email },
      });
      await tx.shop.upsert({
        where: { tiktokShopId: def.tiktokShopId },
        create: {
          id: shopId,
          tiktokShopId: def.tiktokShopId,
          shopCipher: def.shopCipher,
          code: shopCode(def.tiktokShopId),
          name: def.name,
          sellerId,
        },
        update: { name: def.name, shopCipher: def.shopCipher, code: shopCode(def.tiktokShopId) },
      });
      const warehouseIds: string[] = [];
      for (const wh of def.warehouses) {
        const id = detId(`warehouse:${def.key}:${wh.code}`);
        warehouseIds.push(id);
        await tx.warehouse.upsert({
          where: { shopId_code: { shopId, code: wh.code } },
          create: { id, shopId, externalId: numericId('7600', `warehouse:${def.key}:${wh.code}`), ...wh },
          update: { name: wh.name, city: wh.city, isDefault: wh.isDefault },
        });
      }
      for (const b of def.buyers) {
        await tx.buyer.upsert({
          where: { externalId: `sim-buyer-${b.code}` },
          create: {
            id: detId(`buyer:${b.code}`),
            externalId: `sim-buyer-${b.code}`,
            shopId,
            name: b.name,
            email: `buyer.${b.code}@simulator.local`,
            phone: b.phone,
            addressLine: b.addressLine,
            district: b.district,
            city: b.city,
          },
          update: { name: b.name, phone: b.phone },
        });
      }
      for (const p of def.products) {
        const productId = detId(`product:${def.key}:${p.code}`);
        const productExternalId = p.externalId ?? `sim-product-${p.code}`;
        await tx.product.upsert({
          where: { shopId_externalId: { shopId, externalId: productExternalId } },
          create: { id: productId, shopId, externalId: productExternalId, title: p.title, description: p.description, status: p.status ?? 'ACTIVATE', ...listingData(p) },
          update: {},
        });
        const productRow = await tx.product.findUniqueOrThrow({ where: { shopId_externalId: { shopId, externalId: productExternalId } } });
        for (const s of p.skus) {
          const skuExternalId = s.externalId ?? `sim-sku-${def.key}-${s.code}`;
          // Re-read the row: a database seeded before Phase 04 keeps its older row ids, so never assume the derived id.
          const { id: skuId } = await tx.sku.upsert({
            where: { shopId_externalId: { shopId, externalId: skuExternalId } },
            create: { id: detId(`sku:${def.key}:${skuExternalId}`), productId: productRow.id, shopId, externalId: skuExternalId, sellerSku: s.code, name: s.name, priceVnd: s.priceVnd },
            update: {},
            select: { id: true },
          });
          for (let i = 0; i < warehouseIds.length; i++) {
            await tx.inventoryLevel.upsert({
              where: { skuId_warehouseId: { skuId, warehouseId: warehouseIds[i] } },
              create: { id: detId(`inv:${def.key}:${skuExternalId}:${i}`), skuId, warehouseId: warehouseIds[i], quantity: s.stock[i] ?? 0 },
              update: {},
            });
          }
        }
      }
      for (const sc of SEED_SCENARIOS) {
        await tx.scenario.upsert({
          where: { shopId_key: { shopId, key: sc.key } },
          create: { id: detId(`scenario:${def.key}:${sc.key}`), shopId, key: sc.key, name: sc.name, description: sc.description, config: sc.config },
          update: { name: sc.name, description: sc.description, config: sc.config },
        });
      }
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
      if (!shop.activeScenarioId) {
        await tx.shop.update({ where: { id: shopId }, data: { activeScenarioId: detId(`scenario:${def.key}:default`) } });
      }
    }, SEED_TX_OPTIONS);
    await seedConversations(this.prisma, await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } }), def.key);
    this.logger.log(`seeded shop ${def.tiktokShopId}`);
  }

  async summary(): Promise<SeedSummary> {
    const [shops, sellers, buyers, warehouses, products, skus, inventoryLevels, scenarios, apps] = await Promise.all([
      this.prisma.shop.count(),
      this.prisma.seller.count(),
      this.prisma.buyer.count(),
      this.prisma.warehouse.count(),
      this.prisma.product.count(),
      this.prisma.sku.count(),
      this.prisma.inventoryLevel.count(),
      this.prisma.scenario.count(),
      this.prisma.app.count(),
    ]);
    return { shops, sellers, buyers, warehouses, products, skus, inventoryLevels, scenarios, apps };
  }
}
