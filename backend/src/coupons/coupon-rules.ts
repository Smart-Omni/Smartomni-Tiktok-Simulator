import { BadRequestException } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/** OAS coupon `status` values. The status is derived, never stored. */
export type CouponStatus = 'NOT_START' | 'ONGOING' | 'EXPIRED' | 'DEACTIVATED';

export function couponStatus(c: Pick<Coupon, 'deactivated' | 'startAt' | 'endAt'>, now: Date): CouponStatus {
  if (c.deactivated) return 'DEACTIVATED';
  if (now < c.startAt) return 'NOT_START';
  if (now >= c.endAt) return 'EXPIRED';
  return 'ONGOING';
}

/** A coupon rule violation with a stable machine code (the checkout answers HTTP 400 with `{code, message}`). */
export class CouponRuleError extends BadRequestException {
  constructor(readonly code: string, message: string) {
    super({ code, message });
  }
}

/** Promo codes are letters/digits, 6-12 characters (OAS description of `promo_code`); stored upper-case, matched case-insensitively. */
export const PROMO_CODE_PATTERN = /^[A-Za-z0-9]{6,12}$/;
export const normalizeCode = (code: string): string => code.trim().toUpperCase();

/**
 * Discount in whole VND for a subtotal (sum of the eligible product prices; shipping and tax are never discounted).
 * PERCENT_OFF rounds DOWN, then applies the optional cap; AMOUNT_OFF never exceeds the subtotal.
 */
export function computeDiscount(c: Pick<Coupon, 'discountType' | 'amountOffVnd' | 'percentage' | 'maxDiscountVnd'>, subtotalVnd: number): number {
  let d = 0;
  if (c.discountType === 'AMOUNT_OFF') d = c.amountOffVnd ?? 0;
  else if (c.discountType === 'PERCENT_OFF') {
    d = Math.floor((subtotalVnd * (c.percentage ?? 0)) / 100);
    if (c.maxDiscountVnd != null) d = Math.min(d, c.maxDiscountVnd);
  }
  return Math.max(0, Math.min(d, subtotalVnd));
}

/**
 * Split `total` over `weights` proportionally in integer VND (largest remainder; ties go to the earlier index), so the parts always sum to
 * `total` and the result is deterministic for the same input.
 */
export function distributeProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left -= 1;
  }
  return base;
}

export interface AppliedCoupon {
  couponId: string;
  discountVnd: number;
}

/**
 * Checkout hook (runs INSIDE the checkout transaction): validates the code for this shop/buyer/subtotal at business time `now`,
 * then takes one redemption with a guarded UPDATE (`redeemedCount < redemptionLimit`), so concurrent checkouts can never exceed the limit.
 * The caller records the CouponUsage row after the order exists (unique (coupon, order)); if the transaction rolls back, so does the increment.
 */
export async function reserveCoupon(
  tx: Prisma.TransactionClient,
  args: { shopId: string; buyerId: string; code: string; subtotalVnd: number; now: Date },
): Promise<AppliedCoupon> {
  const coupon = await tx.coupon.findUnique({ where: { shopId_promoCode: { shopId: args.shopId, promoCode: normalizeCode(args.code) } } });
  if (!coupon) throw new CouponRuleError('coupon_not_found', 'this coupon code does not exist in this shop');
  const status = couponStatus(coupon, args.now);
  if (status === 'DEACTIVATED') throw new CouponRuleError('coupon_deactivated', 'this coupon was deactivated by the seller');
  if (status === 'NOT_START') throw new CouponRuleError('coupon_not_started', 'this coupon is not valid yet');
  if (status === 'EXPIRED') throw new CouponRuleError('coupon_expired', 'this coupon has expired');
  if (coupon.minSpendVnd != null && args.subtotalVnd < coupon.minSpendVnd) {
    throw new CouponRuleError('coupon_min_spend', `the order must be at least ${coupon.minSpendVnd} VND to use this coupon`);
  }
  if (coupon.audience === 'NEW') {
    const prior = await tx.order.count({ where: { shopId: args.shopId, buyerId: args.buyerId, status: { not: 'CANCELLED' } } });
    if (prior > 0) throw new CouponRuleError('coupon_not_eligible', 'this coupon is only for buyers without earlier orders in this shop');
  }
  const discountVnd = computeDiscount(coupon, args.subtotalVnd);
  if (discountVnd <= 0) throw new CouponRuleError('coupon_no_discount', 'this coupon gives no discount for this order');
  const taken = await tx.$executeRaw`
    UPDATE "Coupon" SET "redeemedCount" = "redeemedCount" + 1
    WHERE id = ${coupon.id} AND ("redemptionLimit" IS NULL OR "redeemedCount" < "redemptionLimit")`;
  if (taken !== 1) throw new CouponRuleError('coupon_exhausted', 'this coupon has no redemptions left');
  return { couponId: coupon.id, discountVnd };
}

export async function recordCouponUsage(tx: Prisma.TransactionClient, applied: AppliedCoupon, orderId: string, now: Date): Promise<void> {
  await tx.couponUsage.create({ data: { id: randomUUID(), couponId: applied.couponId, orderId, discountVnd: applied.discountVnd, createdAt: now } });
}

/**
 * Gives the redemption back when an order is cancelled BEFORE payment. Exactly once: the usage row is deleted first and the counter
 * is decremented only if that delete removed a row, so a repeated cancel can never return it twice. After payment the redemption stays used.
 * Phase 09c (Q8): a code of a batch (batchId set) is also deactivated ("burned") in the same UPDATE, at business time `now`: a single-use
 * code already handed to one customer must not go back to the pool. A single voucher (batchId NULL) keeps the 09a-5 rule and is untouched.
 */
export async function releaseCouponForOrder(tx: Prisma.TransactionClient, orderId: string, now: Date): Promise<void> {
  const usage = await tx.couponUsage.findFirst({ where: { orderId } });
  if (!usage) return;
  const removed = await tx.couponUsage.deleteMany({ where: { id: usage.id } });
  if (removed.count === 1) {
    await tx.$executeRaw`
      UPDATE "Coupon" SET
        "redeemedCount" = GREATEST("redeemedCount" - 1, 0),
        "deactivated" = CASE WHEN "batchId" IS NOT NULL THEN true ELSE "deactivated" END,
        "updatedAt" = CASE WHEN "batchId" IS NOT NULL THEN ${now} ELSE "updatedAt" END
      WHERE id = ${usage.couponId}`;
  }
}
