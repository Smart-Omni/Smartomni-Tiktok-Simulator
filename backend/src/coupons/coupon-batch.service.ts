import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { CouponStatus, couponStatus } from './coupon-rules';
import { cryptoRandomInt, generatePromoCode, RandomInt } from './promo-code';

export const MAX_BATCH_QUANTITY = 500;
/** A whole batch is retried this many times when another request inserted one of its codes between the check and the insert. */
const MAX_TX_ATTEMPTS = 3;

export type BatchDiscount = { type: 'AMOUNT_OFF'; amountVnd: number } | { type: 'PERCENT_OFF'; percentage: number; maxDiscountVnd?: number };

export interface CreateBatchInput {
  title: string;
  discount: BatchDiscount;
  minSpendVnd?: number;
  /** BUSINESS-clock times; default start = now. */
  startAt?: Date;
  endAt: Date;
  audience?: 'ALL' | 'NEW';
  quantity: number;
}

export interface CouponBatchSummary {
  id: string;
  title: string;
  status: CouponStatus;
  discountType: string;
  amountOffVnd: number | null;
  percentage: number | null;
  maxDiscountVnd: number | null;
  minSpendVnd: number | null;
  audience: string;
  startAt: Date;
  endAt: Date;
  createdAt: Date;
  quantity: number;
  /** Codes used in an order (each code is single-use, so this is the sum of redeemedCount). */
  redeemed: number;
}

export interface CouponBatchCode {
  id: string;
  promoCode: string;
  redeemedCount: number;
  status: CouponStatus;
}

const isUniqueViolation = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Phase 09c: batches of single-use promo codes (one Coupon row per code, redemptionLimit = 1, same batchId). There is no batch table: the
 * batch data is the same on every code. Seller Center (/demo) and /test-admin use this service; the TikTok router never imports it.
 */
@Injectable()
export class CouponBatchService {
  /** Randomness of the code generator; tests replace it to force collisions. */
  rand: RandomInt = cryptoRandomInt;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * `n` distinct generated codes that no coupon of the shop uses yet (manual codes included). Run inside the inserting transaction; a
   * concurrent insert of the same code is still caught by the (shopId, promoCode) unique index.
   */
  async generateUniqueCodes(tx: Prisma.TransactionClient, shopId: string, n: number): Promise<string[]> {
    const codes = new Set<string>();
    const taken = new Set<string>();
    const maxDraws = n * 50 + 1000;
    let draws = 0;
    for (;;) {
      while (codes.size < n) {
        if (++draws > maxDraws) throw new ConflictException('could not generate unique promo codes; retry');
        const code = generatePromoCode(this.rand);
        if (!taken.has(code)) codes.add(code);
      }
      const existing = await tx.coupon.findMany({ where: { shopId, promoCode: { in: [...codes] } }, select: { promoCode: true } });
      if (existing.length === 0) return [...codes];
      for (const e of existing) {
        codes.delete(e.promoCode);
        taken.add(e.promoCode);
      }
    }
  }

  /** Creates all `quantity` codes or none (one transaction, retried whole on a unique-code race). */
  async createBatch(shopId: string, input: CreateBatchInput, now: Date): Promise<{ batch: CouponBatchSummary; codes: { id: string; promoCode: string }[] }> {
    validate(input);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const codes = await this.generateUniqueCodes(tx, shopId, input.quantity);
          const batchId = randomUUID();
          const rows: Prisma.CouponCreateManyInput[] = codes.map((promoCode) => {
            const id = randomUUID();
            return {
              id,
              shopId,
              externalId: numericId('7700', `coupon:${id}`),
              title: input.title,
              promoCode,
              discountType: input.discount.type,
              amountOffVnd: input.discount.type === 'AMOUNT_OFF' ? input.discount.amountVnd : null,
              percentage: input.discount.type === 'PERCENT_OFF' ? input.discount.percentage : null,
              maxDiscountVnd: input.discount.type === 'PERCENT_OFF' ? (input.discount.maxDiscountVnd ?? null) : null,
              minSpendVnd: input.minSpendVnd ?? null,
              startAt: input.startAt ?? now,
              endAt: input.endAt,
              redemptionLimit: 1,
              audience: input.audience ?? 'ALL',
              batchId,
              createdAt: now,
              updatedAt: now,
            };
          });
          await tx.coupon.createMany({ data: rows });
          const created = await tx.coupon.findMany({ where: { shopId, batchId }, orderBy: { seq: 'asc' } });
          return { batch: summarize(created, now), codes: created.map((c) => ({ id: c.externalId, promoCode: c.promoCode })) };
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (attempt >= MAX_TX_ATTEMPTS) throw new ConflictException('could not generate unique promo codes; retry');
      }
    }
  }

  /** Deactivates every code of the batch. Returns the number of codes of the batch (0 = unknown batch); repeating it is harmless. */
  async deactivateBatch(shopId: string, batchId: string, now: Date): Promise<number> {
    const total = await this.prisma.coupon.count({ where: { shopId, batchId } });
    if (total > 0) await this.prisma.coupon.updateMany({ where: { shopId, batchId, deactivated: false }, data: { deactivated: true, updatedAt: now } });
    return total;
  }

  /** Batches of the shop, newest first. */
  async listBatches(shopId: string, now: Date): Promise<CouponBatchSummary[]> {
    const rows = await this.prisma.coupon.findMany({ where: { shopId, batchId: { not: null } }, orderBy: { seq: 'asc' } });
    const groups = new Map<string, Coupon[]>();
    for (const c of rows) {
      const g = groups.get(c.batchId!);
      if (g) g.push(c);
      else groups.set(c.batchId!, [c]);
    }
    return [...groups.values()].reverse().map((g) => summarize(g, now));
  }

  async getBatch(shopId: string, batchId: string, now: Date): Promise<(CouponBatchSummary & { codes: CouponBatchCode[] }) | null> {
    const rows = await this.prisma.coupon.findMany({ where: { shopId, batchId }, orderBy: { seq: 'asc' } });
    if (rows.length === 0) return null;
    return {
      ...summarize(rows, now),
      codes: rows.map((c) => ({ id: c.externalId, promoCode: c.promoCode, redeemedCount: c.redeemedCount, status: couponStatus(c, now) })),
    };
  }
}

function validate(input: CreateBatchInput): void {
  const int = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
  if (!int(input.quantity, 1, MAX_BATCH_QUANTITY)) throw new BadRequestException(`quantity must be an integer between 1 and ${MAX_BATCH_QUANTITY}`);
  const title = input.title.trim();
  if (title.length < 1 || title.length > 100) throw new BadRequestException('title must be 1-100 characters');
  const d = input.discount;
  if (d.type === 'AMOUNT_OFF' && !int(d.amountVnd, 1, 2_000_000_000)) throw new BadRequestException('amountVnd must be a positive integer');
  if (d.type === 'PERCENT_OFF') {
    if (!int(d.percentage, 1, 100)) throw new BadRequestException('percentage must be an integer between 1 and 100');
    if (d.maxDiscountVnd != null && !int(d.maxDiscountVnd, 1, 2_000_000_000)) throw new BadRequestException('maxDiscountVnd must be a positive integer');
  }
  if (input.minSpendVnd != null && !int(input.minSpendVnd, 1, 2_000_000_000)) throw new BadRequestException('minSpendVnd must be a positive integer');
  if (input.startAt && input.startAt >= input.endAt) throw new BadRequestException('endAt must be after startAt');
}

/**
 * All codes of a batch share title, discount and window, so the first one describes the batch. Codes can be deactivated one by one (a burned
 * code, Q8, or a single code switched off), so the batch is DEACTIVATED only when every code is; otherwise its status comes from the window.
 */
function summarize(codes: Coupon[], now: Date): CouponBatchSummary {
  const c = codes[0];
  const allOff = codes.every((x) => x.deactivated);
  return {
    id: c.batchId!,
    title: c.title,
    status: allOff ? 'DEACTIVATED' : couponStatus({ deactivated: false, startAt: c.startAt, endAt: c.endAt }, now),
    discountType: c.discountType,
    amountOffVnd: c.amountOffVnd,
    percentage: c.percentage,
    maxDiscountVnd: c.maxDiscountVnd,
    minSpendVnd: c.minSpendVnd,
    audience: c.audience,
    startAt: c.startAt,
    endAt: c.endAt,
    createdAt: c.createdAt,
    quantity: codes.length,
    redeemed: codes.reduce((s, x) => s + x.redeemedCount, 0),
  };
}
