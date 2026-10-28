import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BusinessClock } from '../clock/clock';
import { ZodPipe } from '../common/zod.pipe';
import { couponStatus, normalizeCode, PROMO_CODE_PATTERN } from '../coupons/coupon-rules';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { assertSellerShop, assertShopAccess, DemoPrincipal, DemoRequest, DemoSessionGuard } from './demo-session.guard';

const Money = z.number().int().min(1).max(2_000_000_000);
const Discount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('AMOUNT_OFF'), amountVnd: Money }),
  z.object({ type: z.literal('PERCENT_OFF'), percentage: z.number().int().min(1).max(100), maxDiscountVnd: Money.optional() }),
]);
const CreateCoupon = z
  .object({
    title: z.string().trim().min(1).max(100),
    promoCode: z.string().trim().regex(PROMO_CODE_PATTERN, 'promo code must be 6-12 letters or digits'),
    discount: Discount,
    minSpendVnd: Money.optional(),
    /** ISO times on the BUSINESS clock; default start = now. */
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime(),
    redemptionLimit: z.number().int().min(1).max(1_000_000).optional(),
    /** REPEAT_CUSTOMERS is not modelled by the simulator. */
    audience: z.enum(['ALL', 'NEW']).default('ALL'),
  })
  .refine((v) => !v.startAt || new Date(v.startAt) < new Date(v.endAt), { message: 'endAt must be after startAt', path: ['endAt'] });
/** The code and the discount are immutable: orders may already carry their snapshot. */
const UpdateCoupon = z
  .object({
    title: z.string().trim().min(1).max(100),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    redemptionLimit: z.number().int().min(1).max(1_000_000).nullable(),
    minSpendVnd: Money.nullable(),
    deactivated: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

function principal(req: DemoRequest): DemoPrincipal {
  return req.demo!;
}


function discountText(c: Coupon): string {
  return c.discountType === 'AMOUNT_OFF' ? `${c.amountOffVnd} VND off` : `${c.percentage}% off${c.maxDiscountVnd != null ? ` (max ${c.maxDiscountVnd} VND)` : ''}`;
}

function sellerView(c: Coupon, now: Date) {
  return {
    id: c.externalId,
    title: c.title,
    promoCode: c.promoCode,
    status: couponStatus(c, now),
    discountType: c.discountType,
    amountOffVnd: c.amountOffVnd,
    percentage: c.percentage,
    maxDiscountVnd: c.maxDiscountVnd,
    discountText: discountText(c),
    minSpendVnd: c.minSpendVnd,
    startAt: c.startAt.toISOString(),
    endAt: c.endAt.toISOString(),
    redemptionLimit: c.redemptionLimit,
    redeemedCount: c.redeemedCount,
    audience: c.audience,
  };
}

/**
 * Seller-created coupon DATA and the Buyer list of usable coupons. These are /demo endpoints: the TikTok router has no coupon-creation operation
 * (manifest `promotion.coupon_create` is unsupported), so creating a coupon here is fake-marketplace data setup, not an API of TikTok.
 */
@Controller()
export class CouponsDemoController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
  ) {}

  @Get('shops/:shopId/coupons')
  @UseGuards(DemoSessionGuard)
  async list(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const now = this.clock.now();
    const rows = await this.prisma.coupon.findMany({ where: { shopId }, orderBy: { seq: 'asc' } });
    if (p.role === 'SELLER') return { items: rows.map((c) => sellerView(c, now)) };
    // Buyer: only coupons that could be used right now (ongoing, not exhausted, audience matches). The code is shown so it can be typed at checkout.
    const prior = p.buyerId ? await this.prisma.order.count({ where: { shopId, buyerId: p.buyerId, status: { not: 'CANCELLED' } } }) : 0;
    const usable = rows.filter((c) => couponStatus(c, now) === 'ONGOING' && (c.redemptionLimit == null || c.redeemedCount < c.redemptionLimit) && (c.audience === 'ALL' || prior === 0));
    return { items: usable.map((c) => ({ id: c.externalId, title: c.title, promoCode: c.promoCode, discountText: discountText(c), minSpendVnd: c.minSpendVnd, endAt: c.endAt.toISOString() })) };
  }

  @Post('shops/:shopId/coupons')
  @UseGuards(DemoSessionGuard)
  async create(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateCoupon)) body: z.infer<typeof CreateCoupon>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const now = this.clock.now();
    const id = randomUUID();
    try {
      const c = await this.prisma.coupon.create({
        data: {
          id,
          shopId,
          externalId: numericId('7700', `coupon:${id}`),
          title: body.title,
          promoCode: normalizeCode(body.promoCode),
          discountType: body.discount.type,
          amountOffVnd: body.discount.type === 'AMOUNT_OFF' ? body.discount.amountVnd : null,
          percentage: body.discount.type === 'PERCENT_OFF' ? body.discount.percentage : null,
          maxDiscountVnd: body.discount.type === 'PERCENT_OFF' ? (body.discount.maxDiscountVnd ?? null) : null,
          minSpendVnd: body.minSpendVnd ?? null,
          startAt: body.startAt ? new Date(body.startAt) : now,
          endAt: new Date(body.endAt),
          redemptionLimit: body.redemptionLimit ?? null,
          audience: body.audience,
          createdAt: now,
          updatedAt: now,
        },
      });
      return sellerView(c, now);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This promo code already exists in the shop');
      throw e;
    }
  }

  @Patch('shops/:shopId/coupons/:couponId')
  @UseGuards(DemoSessionGuard)
  async update(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('couponId') couponId: string, @Body(new ZodPipe(UpdateCoupon)) body: z.infer<typeof UpdateCoupon>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.prisma.coupon.findUnique({ where: { shopId_externalId: { shopId, externalId: couponId } } });
    if (!existing) throw new NotFoundException('Unknown coupon');
    const startAt = body.startAt ? new Date(body.startAt) : existing.startAt;
    const endAt = body.endAt ? new Date(body.endAt) : existing.endAt;
    if (startAt >= endAt) throw new BadRequestException('endAt must be after startAt');
    if (body.redemptionLimit != null && body.redemptionLimit < existing.redeemedCount) throw new BadRequestException('redemptionLimit cannot be below the redemptions already used');
    const now = this.clock.now();
    const c = await this.prisma.coupon.update({
      where: { id: existing.id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.redemptionLimit !== undefined && { redemptionLimit: body.redemptionLimit }),
        ...(body.minSpendVnd !== undefined && { minSpendVnd: body.minSpendVnd }),
        ...(body.deactivated !== undefined && { deactivated: body.deactivated }),
        startAt,
        endAt,
        updatedAt: now,
      },
    });
    return sellerView(c, now);
  }
}
