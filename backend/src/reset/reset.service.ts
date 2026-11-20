import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PersistentBusinessClock } from '../clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { SeedService } from '../seed/seed.service';

export type ResetScope = 'LOGS' | 'WEBHOOKS' | 'SHOP' | 'ALL';
export const RESET_SCOPES: ResetScope[] = ['LOGS', 'WEBHOOKS', 'SHOP', 'ALL'];

export interface ResetPlan {
  scope: ResetScope;
  shopId: string | null;
  description: string;
  affects: Record<string, number>;
  database: string;
  confirmationToken: string;
  expiresAt: string;
}

@Injectable()
export class ResetService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PersistentBusinessClock) private readonly clock: PersistentBusinessClock,
    @Inject(SeedService) private readonly seed: SeedService,
  ) {}

  /** Name of the database this process is connected to; resets refuse anything that is not a simulator DB. */
  databaseName(): string {
    try {
      return decodeURIComponent(new URL(this.config.databaseUrl).pathname.replace(/^\//, ''));
    } catch {
      return '';
    }
  }

  private assertSimulatorDatabase(): void {
    if (!/simulator/i.test(this.databaseName())) {
      throw new ForbiddenException('Refusing to reset: the connected database name does not contain "simulator".');
    }
  }

  private sign(scope: ResetScope, shopId: string | null, exp: number): string {
    return createHmac('sha256', this.config.testAdminToken).update(`reset|${scope}|${shopId ?? ''}|${exp}`).digest('hex');
  }

  async prepare(scope: ResetScope, shopId?: string | null): Promise<ResetPlan> {
    this.assertSimulatorDatabase();
    if (scope === 'SHOP' && !shopId) throw new BadRequestException('shopId is required for scope SHOP');
    if (scope !== 'SHOP' && shopId) throw new BadRequestException('shopId is only allowed for scope SHOP');
    if (shopId) await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } }).catch(() => {
      throw new BadRequestException('Unknown shopId');
    });
    const exp = Date.now() + this.config.resetConfirmTtlMs;
    const affects = await this.count(scope, shopId ?? null);
    return {
      scope,
      shopId: shopId ?? null,
      description: this.describe(scope),
      affects,
      database: this.databaseName(),
      confirmationToken: `${exp}.${this.sign(scope, shopId ?? null, exp)}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  private describe(scope: ResetScope): string {
    switch (scope) {
      case 'LOGS':
        return 'Deletes all HTTP request logs. Business data and webhook history are kept.';
      case 'WEBHOOKS':
        return 'Deletes all webhook jobs and delivery attempts. Business data is kept.';
      case 'SHOP':
        return 'Deletes ALL data of one shop (catalog, inventory, buyers, tokens, webhooks, sessions, faults) and re-seeds its baseline.';
      case 'ALL':
        return 'Deletes ALL simulator data (every shop, token, log, webhook, clock offset) and re-seeds the baseline. SmartOmni databases are never touched.';
    }
  }

  private async count(scope: ResetScope, shopId: string | null): Promise<Record<string, number>> {
    const p = this.prisma;
    switch (scope) {
      case 'LOGS':
        return { httpRequestLogs: await p.httpRequestLog.count() };
      case 'WEBHOOKS':
        return { webhookJobs: await p.webhookJob.count(), webhookAttempts: await p.webhookAttempt.count() };
      case 'SHOP':
        return {
          webhookJobs: await p.webhookJob.count({ where: { shopId: shopId! } }),
          orders: await p.order.count({ where: { shopId: shopId! } }),
          products: await p.product.count({ where: { shopId: shopId! } }),
          skus: await p.sku.count({ where: { shopId: shopId! } }),
          buyers: await p.buyer.count({ where: { shopId: shopId! } }),
          tokens: await p.token.count({ where: { shopId: shopId! } }),
          authorizationCodes: await p.authorizationCode.count({ where: { shopId: shopId! } }),
          httpRequestLogs: await p.httpRequestLog.count({ where: { shopId: shopId! } }),
        };
      case 'ALL':
        return {
          shops: await p.shop.count(),
          orders: await p.order.count(),
          products: await p.product.count(),
          buyers: await p.buyer.count(),
          tokens: await p.token.count(),
          authorizationCodes: await p.authorizationCode.count(),
          webhookJobs: await p.webhookJob.count(),
          httpRequestLogs: await p.httpRequestLog.count(),
        };
    }
  }

  private verify(scope: ResetScope, shopId: string | null, token: string): void {
    const [expRaw, mac] = token.split('.');
    const exp = Number(expRaw);
    if (!mac || !Number.isFinite(exp)) throw new ForbiddenException('Invalid confirmation token');
    const expected = Buffer.from(this.sign(scope, shopId, exp));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ForbiddenException('Confirmation token does not match the requested scope');
    }
    if (Date.now() > exp) throw new ForbiddenException('Confirmation token expired; request a new one');
  }

  async execute(scope: ResetScope, shopId: string | null, confirmationToken: string): Promise<{ scope: ResetScope; deleted: Record<string, number> }> {
    this.assertSimulatorDatabase();
    if (scope === 'SHOP' && !shopId) throw new BadRequestException('shopId is required for scope SHOP');
    this.verify(scope, shopId, confirmationToken);
    const deleted = await this.count(scope, shopId);
    const p = this.prisma;
    switch (scope) {
      case 'LOGS':
        await p.httpRequestLog.deleteMany();
        break;
      case 'WEBHOOKS':
        await p.webhookJob.deleteMany();
        break;
      case 'SHOP': {
        const shop = await p.shop.findUniqueOrThrow({ where: { id: shopId! } });
        await p.$transaction([
          p.webhookJob.deleteMany({ where: { shopId: shopId! } }),
          p.demoSession.deleteMany({ where: { shopId: shopId! } }),
          p.faultRule.deleteMany({ where: { shopId: shopId! } }),
          // orders first (Order -> Shop/Buyer are RESTRICT); lines, audits, packages, tracking and coupon usages cascade from the order
          p.aftersaleRequest.deleteMany({ where: { shopId: shopId! } }),
          p.order.deleteMany({ where: { shopId: shopId! } }),
          p.conversation.deleteMany({ where: { shopId: shopId! } }),
          p.coupon.deleteMany({ where: { shopId: shopId! } }),
          p.authorizationCode.deleteMany({ where: { shopId: shopId! } }),
          p.token.deleteMany({ where: { shopId: shopId! } }),
          p.httpRequestLog.deleteMany({ where: { shopId: shopId! } }),
          p.inventoryUpdateAttempt.deleteMany({ where: { shopId: shopId! } }),
          p.inventoryChange.deleteMany({ where: { shopId: shopId! } }),
          p.inventoryLevel.deleteMany({ where: { sku: { shopId: shopId! } } }),
          p.sku.deleteMany({ where: { shopId: shopId! } }),
          p.mediaAsset.deleteMany({ where: { shopId: shopId! } }),
          p.product.deleteMany({ where: { shopId: shopId! } }),
          p.warehouse.deleteMany({ where: { shopId: shopId! } }),
          p.buyer.deleteMany({ where: { shopId: shopId! } }),
          p.scenario.deleteMany({ where: { shopId: shopId! } }),
          p.shop.delete({ where: { id: shopId! } }),
        ]);
        await this.seed.seedShopByTiktokId(shop.tiktokShopId);
        break;
      }
      case 'ALL':
        await p.$transaction([
          p.webhookJob.deleteMany(),
          p.demoSession.deleteMany(),
          p.faultRule.deleteMany(),
          p.aftersaleRequest.deleteMany(),
          p.order.deleteMany(),
          p.conversation.deleteMany(),
          p.coupon.deleteMany(),
          p.authorizationCode.deleteMany(),
          p.token.deleteMany(),
          p.httpRequestLog.deleteMany(),
          p.inventoryUpdateAttempt.deleteMany(),
          p.inventoryChange.deleteMany(),
          p.inventoryLevel.deleteMany(),
          p.sku.deleteMany(),
          p.mediaAsset.deleteMany(),
          p.product.deleteMany(),
          p.warehouse.deleteMany(),
          p.buyer.deleteMany(),
          p.scenario.deleteMany(),
          p.shop.deleteMany(),
          p.seller.deleteMany(),
          p.app.deleteMany(),
          p.clockState.deleteMany(),
        ]);
        await this.clock.reload();
        await this.seed.seedAll();
        break;
    }
    return { scope, deleted };
  }
}
