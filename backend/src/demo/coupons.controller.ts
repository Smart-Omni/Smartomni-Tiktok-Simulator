import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BusinessClock } from '../clock/clock';
import { ZodPipe } from '../common/zod.pipe';
import { CouponBatchService, CouponBatchSummary, MAX_BATCH_QUANTITY } from '../coupons/coupon-batch.service';
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
    /** Optional since 09c: left out (or empty), a 10-character code is generated (same generator as the batches). */
    promoCode: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v === '' ? undefined : v))
      .refine((v) => v === undefined || PROMO_CODE_PATTERN.test(v), 'promo code must be 6-12 letters or digits'),
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
/** Phase 09c: a batch of single-use codes. Same fields as a coupon without promoCode/redemptionLimit (always 1), plus the quantity. */
const CreateBatch = z
  .object({
    title: z.string().trim().min(1).max(100),
    discount: Discount,
    minSpendVnd: Money.optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime(),
    audience: z.enum(['ALL', 'NEW']).default('ALL'),
    quantity: z.number().int().min(1).max(MAX_BATCH_QUANTITY),
  })
  .strict()
  .refine((v) => !v.startAt || new Date(v.startAt) < new Date(v.endAt), { message: 'endAt must be after startAt', path: ['endAt'] });
/** Only switching the whole batch off is supported; a single code is edited through PATCH /coupons/:couponId. */
const UpdateBatch = z.object({ deactivated: z.literal(true) }).strict();

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


function discountText(c: Pick<Coupon, 'discountType' | 'amountOffVnd' | 'percentage' | 'maxDiscountVnd'>): string {
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

function batchView(b: CouponBatchSummary) {
  return {
    id: b.id,
    title: b.title,
    status: b.status,
    discountType: b.discountType,
    amountOffVnd: b.amountOffVnd,
    percentage: b.percentage,
    maxDiscountVnd: b.maxDiscountVnd,
    discountText: discountText(b),
    minSpendVnd: b.minSpendVnd,
    audience: b.audience,
    quantity: b.quantity,
    redeemed: b.redeemed,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
  };
}

const isUniqueViolation = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Seller-created coupon DATA and the Buyer list of usable coupons. These are /demo endpoints: the TikTok router has no coupon-creation operation
 * (manifest `promotion.coupon_create` is unsupported), so creating a coupon here is fake-marketplace data setup, not an API of TikTok.
 */
@Controller()
export class CouponsDemoController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(CouponBatchService) private readonly batches: CouponBatchService,
  ) {}

  @Get('shops/:shopId/coupons')
  @UseGuards(DemoSessionGuard)
  async list(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const now = this.clock.now();
    // Phase 09c (Q6): codes of a batch are private and never listed here (the seller reads them per batch under /coupon-batches)
    const rows = await this.prisma.coupon.findMany({ where: { shopId, batchId: null }, orderBy: { seq: 'asc' } });
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
    // a generated code is checked against the shop's codes first and a race on it is retried; a typed duplicate answers 409
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => sellerView(await this.insertCoupon(tx, shopId, body, now), now));
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (body.promoCode !== undefined) throw new ConflictException('This promo code already exists in the shop');
        if (attempt >= 3) throw new ConflictException('could not generate a unique promo code; retry');
      }
    }
  }

  private async insertCoupon(tx: Prisma.TransactionClient, shopId: string, body: z.infer<typeof CreateCoupon>, now: Date): Promise<Coupon> {
    const promoCode = body.promoCode !== undefined ? normalizeCode(body.promoCode) : (await this.batches.generateUniqueCodes(tx, shopId, 1))[0];
    const id = randomUUID();
    return tx.coupon.create({
      data: {
        id,
        shopId,
        externalId: numericId('7700', `coupon:${id}`),
        title: body.title,
        promoCode,
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
  }

  @Patch('shops/:shopId/coupons/:couponId')
  @UseGuards(DemoSessionGuard)
  async update(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('couponId') couponId: string, @Body(new ZodPipe(UpdateCoupon)) body: z.infer<typeof UpdateCoupon>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.prisma.coupon.findUnique({ where: { shopId_externalId: { shopId, externalId: couponId } } });
    if (!existing) throw new NotFoundException('Unknown coupon');
    // Phase 09c (Q8): a code of a batch stays single-use and every non-free state is final, so it can only be switched off
    if (existing.batchId && (body.deactivated !== true || Object.keys(body).length !== 1)) {
      throw new BadRequestException('A code of a batch can only be deactivated ({ "deactivated": true })');
    }
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

  // ---------------------------------------------------------------- Phase 09c: batches of single-use codes (seller only)

  @Post('shops/:shopId/coupon-batches')
  @UseGuards(DemoSessionGuard)
  async createBatch(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateBatch)) body: z.infer<typeof CreateBatch>) {
    assertSellerShop(principal(req), shopId);
    const now = this.clock.now();
    const { batch, codes } = await this.batches.createBatch(
      shopId,
      {
        title: body.title,
        discount: body.discount,
        minSpendVnd: body.minSpendVnd,
        startAt: body.startAt ? new Date(body.startAt) : undefined,
        endAt: new Date(body.endAt),
        audience: body.audience,
        quantity: body.quantity,
      },
      now,
    );
    return { batch: batchView(batch), codes };
  }

  @Get('shops/:shopId/coupon-batches')
  @UseGuards(DemoSessionGuard)
  async listBatches(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    assertSellerShop(principal(req), shopId);
    return { items: (await this.batches.listBatches(shopId, this.clock.now())).map(batchView) };
  }

  @Get('shops/:shopId/coupon-batches/:batchId')
  @UseGuards(DemoSessionGuard)
  async getBatch(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('batchId') batchId: string) {
    assertSellerShop(principal(req), shopId);
    const b = await this.batches.getBatch(shopId, batchId, this.clock.now());
    if (!b) throw new NotFoundException('Unknown coupon batch');
    return { batch: batchView(b), codes: b.codes };
  }

  /** Deactivates every code of the batch (repeating it is harmless). */
  @Patch('shops/:shopId/coupon-batches/:batchId')
  @UseGuards(DemoSessionGuard)
  async updateBatch(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('batchId') batchId: string, @Body(new ZodPipe(UpdateBatch)) _body: z.infer<typeof UpdateBatch>) {
    assertSellerShop(principal(req), shopId);
    const now = this.clock.now();
    if ((await this.batches.deactivateBatch(shopId, batchId, now)) === 0) throw new NotFoundException('Unknown coupon batch');
    const b = (await this.batches.getBatch(shopId, batchId, now))!;
    return { batch: batchView(b), codes: b.codes };
  }
}
