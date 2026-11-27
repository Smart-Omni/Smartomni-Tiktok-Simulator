import { Body, CanActivate, Controller, ExecutionContext, Inject, Injectable, NotFoundException, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { PersistentBusinessClock } from '../clock/clock';
import { ZodPipe } from '../common/zod.pipe';
import { CouponBatchService, MAX_BATCH_QUANTITY } from '../coupons/coupon-batch.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { OrderStatus } from '../orders/order-state';
import { OrderRow, OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';

/** Same shared-secret check as TestAdminGuard, kept in this file to avoid a circular import with test-admin.module.ts. */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(req.header('x-test-admin-token') ?? '');
    const expected = Buffer.from(this.config.testAdminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('Missing or invalid x-test-admin-token');
    return true;
  }
}

const LoyaltyScenario = z.object({ shopId: z.string().min(1), buyerId: z.string().min(1).optional(), thresholdDays: z.number().int().min(1).max(365).default(15) });

const DAY_MS = 24 * 3600 * 1000;

const VoucherTier = z.object({ name: z.string().trim().min(1).max(40), percentage: z.number().int().min(1).max(100), maxDiscountVnd: z.number().int().min(1).max(2_000_000_000).optional() }).strict();
const LoyaltyVouchers = z
  .object({
    shopId: z.string().min(1),
    quantityPerTier: z.number().int().min(1).max(MAX_BATCH_QUANTITY).default(100),
    validDays: z.number().int().min(1).max(365).default(365),
    tiers: z.array(VoucherTier).min(1).max(10).optional(),
  })
  .strict();
/** Test data only: the real percentages are configured by SmartOmni staff. */
const DEFAULT_TIERS: z.infer<typeof VoucherTier>[] = [
  { name: 'Gold', percentage: 10 },
  { name: 'Platinum', percentage: 20 },
  { name: 'Diamond', percentage: 30 },
];

/**
 * Test data for the SmartOmni loyalty rule "points only after N days since completion" (default N = 15, a SmartOmni business rule,
 * NOT a TikTok policy). Orders are driven through the real OrdersService state machine while the BUSINESS clock is frozen at the
 * wanted completion time, so `update_time` / `delivery_time` / audit rows carry that time. The request-signature clock is untouched.
 */
@Controller()
@UseGuards(AdminTokenGuard)
export class LoyaltyAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersistentBusinessClock) private readonly clock: PersistentBusinessClock,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(CouponBatchService) private readonly batches: CouponBatchService,
  ) {}

  /**
   * Phase 09c: one batch of single-use PERCENT_OFF codes per loyalty tier (`Loyalty <tier> <n>%`), valid from now (business clock) for
   * `validDays`. Not idempotent: every call creates new batches. SmartOmni pulls the codes with Search Coupon List (title_keyword).
   */
  @Post('scenarios/loyalty-vouchers')
  async createVouchers(@Body(new ZodPipe(LoyaltyVouchers)) body: z.infer<typeof LoyaltyVouchers>) {
    const shop = await this.prisma.shop.findUnique({ where: { id: body.shopId } });
    if (!shop) throw new NotFoundException('Unknown shop');
    const now = this.clock.now();
    const endAt = new Date(now.getTime() + body.validDays * DAY_MS);
    const batches = [];
    for (const tier of body.tiers ?? DEFAULT_TIERS) {
      const title = `Loyalty ${tier.name} ${tier.percentage}%`;
      const { batch, codes } = await this.batches.createBatch(
        shop.id,
        { title, discount: { type: 'PERCENT_OFF', percentage: tier.percentage, maxDiscountVnd: tier.maxDiscountVnd }, endAt, quantity: body.quantityPerTier },
        now,
      );
      batches.push({ tier: tier.name, batchId: batch.id, title, percentage: tier.percentage, startAt: batch.startAt.toISOString(), endAt: batch.endAt.toISOString(), codes });
    }
    return { shopId: shop.id, batches };
  }

  @Post('scenarios/loyalty-orders')
  async create(@Body(new ZodPipe(LoyaltyScenario)) body: z.infer<typeof LoyaltyScenario>) {
    const shop = await this.prisma.shop.findUnique({ where: { id: body.shopId } });
    if (!shop) throw new NotFoundException('Unknown shop');
    const buyer = await this.prisma.buyer.findFirst({ where: { shopId: shop.id, ...(body.buyerId ? { id: body.buyerId } : {}) }, orderBy: { externalId: 'asc' } });
    if (!buyer) throw new NotFoundException('No buyer for this shop');
    const sku = await this.prisma.sku.findFirst({
      where: { shopId: shop.id, status: 'NORMAL', product: { status: 'ACTIVATE', isNotForSale: false }, inventory: { some: { quantity: { gte: 10 } } } },
      orderBy: { externalId: 'asc' },
    });
    if (!sku) throw new NotFoundException('No on-sale SKU with enough stock');

    const realNow = Date.now();
    const before = this.clock.snapshot();
    const base = this.clock.now().getTime();
    const N = body.thresholdDays;
    const cases: { label: string; completedAt: number | null; stopAt: 'COMPLETED' | 'DELIVERED' | 'AWAITING_SHIPMENT' }[] = [
      { label: `completed ${N + 1} days ago (eligible)`, completedAt: base - (N + 1) * DAY_MS, stopAt: 'COMPLETED' },
      { label: `completed exactly ${N} days ago (boundary)`, completedAt: base - N * DAY_MS, stopAt: 'COMPLETED' },
      { label: `completed ${N} days minus 1 hour ago (not yet eligible)`, completedAt: base - N * DAY_MS + 3600_000, stopAt: 'COMPLETED' },
      { label: 'delivered but not completed (never eligible)', completedAt: base - (N + 1) * DAY_MS, stopAt: 'DELIVERED' },
      { label: 'paid, awaiting shipment (never eligible)', completedAt: base - (N + 1) * DAY_MS, stopAt: 'AWAITING_SHIPMENT' },
    ];
    const created: { label: string; order: OrderRow }[] = [];
    try {
      for (const [i, c] of cases.entries()) {
        await this.clock.setTo(new Date(c.completedAt!), true);
        const key = `loyalty-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const { order } = await this.orders.checkout(
          { id: buyer.id, shopId: shop.id },
          { checkoutKey: key, items: [{ skuExternalId: sku.externalId, quantity: 1 }], recipient: { name: buyer.name, phone: buyer.phone, addressLine: buyer.addressLine, district: buyer.district, city: buyer.city }, buyerMessage: `loyalty scenario: ${c.label}` },
        );
        await this.orders.pay({ id: buyer.id, shopId: shop.id }, order.externalId); // -> AWAITING_SHIPMENT
        let last = await this.orders.findForAdmin(order.id);
        if (c.stopAt !== 'AWAITING_SHIPMENT') {
          const path: OrderStatus[] = ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', ...(c.stopAt === 'COMPLETED' ? (['COMPLETED'] as OrderStatus[]) : [])];
          for (const to of path) last = await this.orders.transition(order.id, to, 'TEST_CONSOLE', { note: `loyalty scenario: ${c.label}` });
        }
        created.push({ label: c.label, order: last });
      }
    } finally {
      // restore the business clock as it was (frozen stays frozen; a running clock keeps its offset)
      const elapsed = Date.now() - realNow;
      if (before.frozen) await this.clock.setTo(new Date(base), true);
      else await this.clock.setTo(new Date(base + elapsed), false);
    }
    return {
      shopId: shop.id,
      thresholdDays: N,
      note: 'Loyalty points are computed by SmartOmni from the product amount actually paid (sub_total), never from total_amount which includes shipping/tax.',
      orders: created.map(({ label, order }) => ({
        label,
        orderId: order.externalId,
        status: order.status,
        completedAt: order.completedAt?.toISOString() ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        updatedAt: order.updatedAt.toISOString(),
        amountsVnd: {
          productTotal: order.originalProductPrice,
          sellerDiscount: order.sellerDiscount,
          platformDiscount: order.platformDiscount,
          subTotal: order.originalProductPrice - order.sellerDiscount - order.platformDiscount,
          shippingFee: order.originalShippingFee - order.shippingFeeDiscount,
          tax: order.tax,
          total: order.originalProductPrice - order.sellerDiscount - order.platformDiscount + (order.originalShippingFee - order.shippingFeeDiscount) + order.tax,
        },
      })),
    };
  }
}
