import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { BusinessClock, PersistentBusinessClock } from '../clock/clock';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, AppConfig } from '../config/config';
import { FaultService } from '../faults/fault.service';
import { historyOf } from '../demo/inventory.controller';
import { couponStatus } from '../coupons/coupon-rules';
import { OAuthModule } from '../oauth/oauth.module';
import { ChatModule } from '../chat/chat.module';
import { ChatAdminController, ChatAdminGuard } from './chat-admin.controller';
import { AdminTokenGuard, LoyaltyAdminController } from './loyalty-admin.controller';
import { AftersaleModule } from '../aftersale/aftersale.module';
import { AftersaleService } from '../aftersale/aftersale.service';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { ORDER_STATUSES } from '../orders/order-state';
import { TokenAdminService } from '../oauth/token-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { RESET_SCOPES, ResetService } from '../reset/reset.service';
import { numericId } from '../seed/seed-data';
import { SeedService } from '../seed/seed.service';
import { WebhookQueueService } from '../webhooks/webhook-queue.service';
import { WebhookWorkerService } from '../webhooks/webhook-worker.service';

/** Shared-secret guard for the test/control plane. TikTok-style auth is never used here. */
@Injectable()
export class TestAdminGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(req.header('x-test-admin-token') ?? '');
    const expected = Buffer.from(this.config.testAdminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('Missing or invalid x-test-admin-token');
    }
    return true;
  }
}

const ResetPrepare = z.object({ scope: z.enum(RESET_SCOPES as [string, ...string[]]), shopId: z.string().min(1).optional() });
const ResetExecute = ResetPrepare.extend({ confirmationToken: z.string().min(10) });
const ClockSet = z.object({ setTo: z.string().datetime().optional(), advanceMs: z.number().int().optional(), freeze: z.boolean().optional(), reset: z.boolean().optional() });
const FaultCreate = z.object({
  shopId: z.string().min(1).nullable().optional(),
  target: z.enum(['API', 'WEBHOOK']),
  kind: z.enum(['HTTP_ERROR', 'DELAY', 'DROP', 'DUPLICATE', 'REORDER', 'TIMEOUT_BEFORE_WRITE', 'TIMEOUT_AFTER_WRITE', 'APP_ERROR_200']),
  pathMatch: z.string().min(1).nullable().optional(),
  params: z.record(z.unknown()).optional(),
  remaining: z.number().int().positive().nullable().optional(),
});
const ScopeRemove = z.object({ scope: z.string().min(1).max(200) });
const CodesExpire = z.object({ shopId: z.string().min(1).optional() });
const ScenarioActivate = z.object({ key: z.string().min(1) });
const WebhookEnqueue = z.object({
  shopId: z.string().min(1),
  topic: z.string().min(1).max(100),
  payload: z.record(z.unknown()),
  targetUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'targetUrl must be http(s)'),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

const AftersaleArbitrate = z.object({
  arbitration_status: z.enum(['IN_ARBITRATION', 'ARBITRATION_WIN', 'ARBITRATION_LOSS']).optional(),
  decision: z.enum(['WIN', 'LOSS', 'ARBITRATION_WIN', 'ARBITRATION_LOSS', 'IN_ARBITRATION']).optional(),
  shopId: z.string().min(1).optional(),
  note: z.string().max(300).optional(),
}).refine((b) => b.arbitration_status || b.decision, { message: 'Either arbitration_status or decision is required' });

const CatalogBulk = z.object({ shopId: z.string().min(1), count: z.number().int().min(1).max(500), skusPerProduct: z.number().int().min(1).max(5).default(2) });

const OrderTransition = z.object({ to: z.enum(ORDER_STATUSES), shopId: z.string().min(1).optional(), note: z.string().max(300).optional(), cancelReason: z.string().max(300).optional() });

type Rq = Request & { requestId?: string };

@Controller()
@UseGuards(TestAdminGuard)
export class TestAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PersistentBusinessClock) private readonly clock: PersistentBusinessClock,
    @Inject(SeedService) private readonly seed: SeedService,
    @Inject(ResetService) private readonly reset: ResetService,
    @Inject(FaultService) private readonly faults: FaultService,
    @Inject(WebhookQueueService) private readonly queue: WebhookQueueService,
    @Inject(WebhookWorkerService) private readonly worker: WebhookWorkerService,
    @Inject(TokenAdminService) private readonly tokens: TokenAdminService,
    @Inject(BusinessClock) private readonly businessClock: BusinessClock,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(AftersaleService) private readonly aftersale: AftersaleService,
  ) {}

  @Get('status')
  async status() {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      /* reported as down */
    }
    const jobs = database === 'up' ? await this.prisma.webhookJob.groupBy({ by: ['status'], _count: { _all: true } }) : [];
    return {
      service: 'smartomni-tiktok-simulator',
      database: { status: database, name: this.reset.databaseName() },
      worker: { enabled: this.config.worker.enabled, running: this.worker.isRunning(), workerId: this.worker.workerId, lastTickAt: this.worker.lastTickAt, lastError: this.worker.lastError },
      webhookJobs: Object.fromEntries(jobs.map((j) => [j.status, j._count._all])),
      clock: this.clock.snapshot(),
      seed: database === 'up' ? await this.seed.summary() : null,
      publicApiBaseUrl: this.config.publicApiBaseUrl,
      hostCallbackBaseUrl: this.config.hostCallbackBaseUrl,
    };
  }

  @Post('seed')
  async runSeed() {
    return { seeded: true, summary: await this.seed.seedAll() };
  }

  @Post('reset/prepare')
  prepareReset(@Body(new ZodPipe(ResetPrepare)) body: z.infer<typeof ResetPrepare>) {
    return this.reset.prepare(body.scope as any, body.shopId);
  }

  @Post('reset')
  executeReset(@Body(new ZodPipe(ResetExecute)) body: z.infer<typeof ResetExecute>) {
    return this.reset.execute(body.scope as any, body.shopId ?? null, body.confirmationToken);
  }

  @Get('clock')
  getClock() {
    return this.clock.snapshot();
  }

  @Put('clock')
  async setClock(@Body(new ZodPipe(ClockSet)) body: z.infer<typeof ClockSet>) {
    if (body.reset) return this.clock.reset();
    if (body.setTo) return this.clock.setTo(new Date(body.setTo), body.freeze ?? false);
    if (body.advanceMs !== undefined) return this.clock.advance(body.advanceMs);
    return this.clock.snapshot();
  }

  @Get('shops')
  async shops() {
    const shops = await this.prisma.shop.findMany({
      orderBy: { name: 'asc' },
      include: { scenarios: { select: { id: true, key: true, name: true, description: true } }, _count: { select: { products: true, buyers: true, webhookJobs: true } } },
    });
    return { items: shops.map((s) => ({ id: s.id, tiktokShopId: s.tiktokShopId, name: s.name, region: s.region, currency: s.currency, status: s.status, activeScenarioId: s.activeScenarioId, scenarios: s.scenarios, counts: s._count })) };
  }

  @Post('shops/:shopId/scenario')
  async activateScenario(@Param('shopId') shopId: string, @Body(new ZodPipe(ScenarioActivate)) body: z.infer<typeof ScenarioActivate>) {
    const scenario = await this.prisma.scenario.findUnique({ where: { shopId_key: { shopId, key: body.key } } });
    if (!scenario) throw new NotFoundException('Unknown scenario for this shop');
    await this.prisma.shop.update({ where: { id: shopId }, data: { activeScenarioId: scenario.id } });
    return { shopId, activeScenarioId: scenario.id, key: scenario.key };
  }

  // ---- Phase 06: inventory history (read only) ----

  @Get('inventory/history')
  async inventoryHistory(@Query('shopId') shopId?: string, @Query('limit') limit?: string) {
    if (!shopId) throw new NotFoundException('shopId is required');
    return historyOf(this.prisma, shopId, limit);
  }

  // ---- Phase 09a: coupons (read-only overview for the Test Console) ----

  @Get('coupons')
  async listCoupons(@Query('shopId') shopId?: string) {
    const now = this.businessClock.now();
    const rows = await this.prisma.coupon.findMany({ where: shopId ? { shopId } : {}, orderBy: { seq: 'asc' }, take: 200 });
    return {
      items: rows.map((c) => ({
        id: c.externalId,
        title: c.title,
        promoCode: c.promoCode,
        status: couponStatus(c, now),
        redeemedCount: c.redeemedCount,
        redemptionLimit: c.redemptionLimit,
        startAt: c.startAt.toISOString(),
        endAt: c.endAt.toISOString(),
      })),
    };
  }

  // ---- Phase 07b: aftersale (cancellations / returns) ----

  @Get('aftersale')
  async listAftersale(@Query('shopId') shopId?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.prisma.aftersaleRequest.findMany({
      where: shopId ? { shopId } : {},
      orderBy: { seq: 'desc' },
      take,
      include: { order: { select: { externalId: true } }, shop: { select: { name: true } }, _count: { select: { lines: true } } },
    });
    return {
      items: rows.map((r) => ({
        id: r.externalId,
        shopId: r.shopId,
        shopName: r.shop.name,
        orderId: r.order.externalId,
        kind: r.kind,
        type: r.type,
        status: r.status,
        units: r._count.lines,
        refundTotalVnd: r.refundTotal,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  @Get('aftersale/:ref/records')
  async aftersaleRecords(@Param('ref') ref: string, @Query('shopId') shopId?: string) {
    const req = await this.aftersale.findForAdmin(ref, shopId);
    return { id: req.externalId, status: req.status, records: (await this.aftersale.records(req.shopId, req.externalId)).map((r) => ({ from: r.fromStatus, to: r.toStatus, actor: r.actor, note: r.note, at: r.at.toISOString() })) };
  }

  /** The refund has been paid out: SUCCESS -> COMPLETE (cancellations and returns). */
  @Post('aftersale/:ref/complete')
  async completeAftersale(@Req() req: Rq, @Param('ref') ref: string, @Query('shopId') shopId?: string) {
    const done = await this.aftersale.complete(ref, shopId, req.requestId);
    return { id: done.externalId, status: done.status };
  }

  // ---- Phase 05: orders (state machine control) ----

  @Get('orders')
  async listOrders(@Query('shopId') shopId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.prisma.order.findMany({
      where: { ...(shopId ? { shopId } : {}), ...(status ? { status } : {}) },
      orderBy: { seq: 'desc' },
      take,
      include: { shop: { select: { name: true, tiktokShopId: true } }, buyer: { select: { name: true } }, _count: { select: { lines: true } } },
    });
    return {
      items: rows.map((o) => ({
        id: o.externalId,
        rowId: o.id,
        shopId: o.shopId,
        shopName: o.shop.name,
        buyerName: o.buyer.name,
        status: o.status,
        units: o._count.lines,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        releaseAt: o.releaseAt?.toISOString() ?? null,
      })),
    };
  }

  @Get('orders/:ref/audit')
  async orderAudit(@Param('ref') ref: string, @Query('shopId') shopId?: string) {
    const order = await this.orders.findForAdmin(ref, shopId);
    return { orderId: order.externalId, status: order.status, history: (await this.orders.audits(order.id)).map((a) => ({ from: a.fromStatus, to: a.toStatus, actor: a.actor, note: a.note, at: a.at.toISOString() })) };
  }

  /** Force a transition through the same state machine the apps use (an invalid jump, e.g. ON_HOLD -> AWAITING_COLLECTION, is refused with 400). */
  @Post('orders/:ref/transition')
  async transitionOrder(@Req() req: Rq, @Param('ref') ref: string, @Body(new ZodPipe(OrderTransition)) body: z.infer<typeof OrderTransition>) {
    const order = await this.orders.findForAdmin(ref, body.shopId);
    const updated = await this.orders.transition(order.id, body.to, 'TEST_CONSOLE', { note: body.note ?? 'test console', cancelReason: body.cancelReason, requestId: req.requestId });
    return { id: updated.externalId, from: order.status, status: updated.status, updatedAt: updated.updatedAt.toISOString() };
  }

  /** Release every ON_HOLD order whose hold period (business clock) has elapsed; advance the clock first to test the boundary. */
  @Post('orders/release-due')
  async releaseDue() {
    return { released: await this.orders.releaseDue() };
  }

  /** Generates ACTIVATE products with several priced SKUs, to exercise multi-page imports. Fake data only. */
  @Post('catalog/bulk')
  async bulkProducts(@Body(new ZodPipe(CatalogBulk)) body: z.infer<typeof CatalogBulk>) {
    const shop = await this.prisma.shop.findUnique({ where: { id: body.shopId }, include: { warehouses: true } });
    if (!shop) throw new NotFoundException('Unknown shop');
    const batch = randomUUID().slice(0, 8);
    const now = this.businessClock.now();
    for (let i = 0; i < body.count; i++) {
      const productId = randomUUID();
      await this.prisma.product.create({
        data: {
          id: productId,
          shopId: shop.id,
          externalId: numericId('7500', `product:${productId}`),
          title: `Bulk ${batch} #${i + 1}`,
          description: 'Generated by /test-admin/catalog/bulk',
          createdAt: now,
          updatedAt: now,
          skus: {
            create: Array.from({ length: body.skusPerProduct }, (_, k) => {
              const skuId = randomUUID();
              return {
                id: skuId,
                shopId: shop.id,
                externalId: numericId('7510', `sku:${skuId}`),
                sellerSku: `BULK-${batch}-${i + 1}-${k + 1}`,
                name: `Variant ${k + 1}`,
                priceVnd: 20000 + ((i * 7 + k * 13) % 50) * 1000,
                createdAt: now,
                updatedAt: now,
                inventory: { create: shop.warehouses.map((w) => ({ id: randomUUID(), warehouseId: w.id, quantity: 10 + ((i + k) % 20) })) },
              };
            }),
          },
        },
      });
    }
    return { shopId: shop.id, created: body.count, skusPerProduct: body.skusPerProduct, totalProducts: await this.prisma.product.count({ where: { shopId: shop.id } }) };
  }

  // ---- Phase 03: authorization / token state (metadata only: never token values or hashes) ----

  @Get('tokens')
  async listTokens(@Query('shopId') shopId?: string) {
    return { items: await this.tokens.list(shopId) };
  }

  @Post('tokens/:id/expire-access')
  expireAccess(@Param('id') id: string) {
    return this.tokens.expireAccess(id);
  }

  @Post('tokens/:id/expire-refresh')
  expireRefresh(@Param('id') id: string) {
    return this.tokens.expireRefresh(id);
  }

  @Post('tokens/:id/revoke')
  revokeToken(@Param('id') id: string) {
    return this.tokens.revoke(id);
  }

  @Post('tokens/:id/remove-scope')
  removeScope(@Param('id') id: string, @Body(new ZodPipe(ScopeRemove)) body: z.infer<typeof ScopeRemove>) {
    return this.tokens.removeScope(id, body.scope);
  }

  @Post('authorization-codes/expire')
  expireCodes(@Body(new ZodPipe(CodesExpire)) body: z.infer<typeof CodesExpire>) {
    return this.tokens.expireCodes(body.shopId);
  }

  @Get('faults')
  async listFaults(@Query('shopId') shopId?: string) {
    return { items: await this.faults.list(shopId) };
  }

  @Post('faults')
  createFault(@Body(new ZodPipe(FaultCreate)) body: z.infer<typeof FaultCreate>) {
    return this.faults.create(body);
  }

  @Delete('faults/:id')
  async removeFault(@Param('id') id: string) {
    await this.faults.remove(id);
    return { deleted: true };
  }

  @Get('http-logs')
  async httpLogs(
    @Query('requestId') requestId?: string,
    @Query('shopId') shopId?: string,
    @Query('router') router?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const items = await this.prisma.httpRequestLog.findMany({
      where: { ...(requestId ? { requestId } : {}), ...(shopId ? { shopId } : {}), ...(router ? { router } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return { items };
  }

  @Get('webhooks')
  async listWebhooks(@Query('requestId') requestId?: string, @Query('shopId') shopId?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const items = await this.prisma.webhookJob.findMany({
      where: { ...(requestId ? { requestId } : {}), ...(shopId ? { shopId } : {}), ...(status ? { status: status as any } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
      include: { attempts: { orderBy: { attemptNo: 'asc' } } },
    });
    return { items };
  }

  @Post('webhooks')
  async enqueueWebhook(@Req() req: Rq, @Body(new ZodPipe(WebhookEnqueue)) body: z.infer<typeof WebhookEnqueue>) {
    await this.prisma.shop.findUniqueOrThrow({ where: { id: body.shopId } }).catch(() => {
      throw new NotFoundException('Unknown shop');
    });
    return this.queue.enqueue({ ...body, payload: body.payload as any, requestId: req.requestId });
  }

  @Post('webhooks/:jobId/replay')
  async replayWebhook(@Req() req: Rq, @Param('jobId') jobId: string) {
    const exists = await this.prisma.webhookJob.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Unknown webhook job');
    return this.queue.replay(jobId, req.requestId);
  }

  @Post('aftersale/:ref/arbitration')
  async arbitrateAftersale(
    @Req() req: Rq,
    @Param('ref') ref: string,
    @Body(new ZodPipe(AftersaleArbitrate)) body: z.infer<typeof AftersaleArbitrate>,
  ) {
    const aftersaleReq = await this.aftersale.findForAdmin(ref, body.shopId);
    const targetStatus = (body.arbitration_status ?? (body.decision?.includes('WIN') ? 'ARBITRATION_WIN' : body.decision?.includes('LOSS') ? 'ARBITRATION_LOSS' : 'IN_ARBITRATION')) as any;
    const result = await this.aftersale.arbitrate(
      aftersaleReq.shopId,
      aftersaleReq.externalId,
      targetStatus,
      'OPERATOR',
      { note: body.note, requestId: req.requestId },
    );
    return {
      id: result.request.externalId,
      arbitration_status: result.request.arbitrationStatus,
      changed: result.changed,
    };
  }
}

@Module({ imports: [OAuthModule, OrdersModule, ChatModule, AftersaleModule], controllers: [TestAdminController, ChatAdminController, LoyaltyAdminController], providers: [TestAdminGuard, ChatAdminGuard, AdminTokenGuard, TokenAdminService] })
export class TestAdminModule {}
