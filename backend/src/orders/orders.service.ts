import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { logInventory } from '../inventory/inventory-log';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { distributeProportionally, recordCouponUsage, releaseCouponForOrder, reserveCoupon } from '../coupons/coupon-rules';
import { canTransition, OrderStatus } from './order-state';

/** Interactive transactions do real work (row locks, several statements); the 5 s Prisma default is too tight under load. */
const TX_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const;

export const MAX_UNITS_PER_SKU = 20;
export const MAX_LINES_PER_ORDER = 50;

export interface CheckoutInput {
  checkoutKey: string;
  items: { skuExternalId: string; quantity: number }[];
  recipient: { name: string; phone: string; addressLine: string; district: string; city: string; postalCode?: string };
  buyerMessage?: string;
  /** Phase 09a: optional promo code of the shop's coupon (see coupons/coupon-rules.ts). */
  couponCode?: string;
}

export type Actor = 'BUYER' | 'SELLER' | 'TEST_CONSOLE' | 'SYSTEM';

/** Context handed to transition listeners; they run INSIDE the transition's transaction, after the order's own event was written. */
export interface TransitionContext {
  tx: Prisma.TransactionClient;
  shop: { id: string; tiktokShopId: string };
  before: OrderRow;
  after: OrderRow;
  to: OrderStatus;
  actor: Actor;
  now: Date;
  requestId?: string;
}
export type TransitionListener = (ctx: TransitionContext) => Promise<void>;

export class OrderRuleError extends BadRequestException {
  constructor(readonly code: string, message: string) {
    super({ code, message });
  }
}

const orderInclude = { lines: { orderBy: [{ externalId: 'asc' }] }, buyer: { select: { externalId: true, name: true } }, shop: { select: { id: true, name: true } } } satisfies Prisma.OrderInclude;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/**
 * Write side of orders: checkout, fake payment, the state machine, stock reservation and event emission.
 * Every status change is one transaction: compare-and-set on the current status, audit row, stock effect and webhook jobs commit together.
 * Business timestamps come from the business clock; worker scheduling and signatures never do.
 */
@Injectable()
export class OrdersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrdersService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: TransitionListener[] = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WebhookEmitter) private readonly emitter: WebhookEmitter,
  ) {}

  /** Other aggregates (packages, aftersale...) react to status changes in the same transaction. */
  addTransitionListener(listener: TransitionListener): void {
    this.listeners.push(listener);
  }

  onApplicationBootstrap(): void {
    const { lifecycleIntervalMs } = this.config.orders;
    if (this.config.worker.enabled && lifecycleIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.releaseDue().catch((e: Error) => this.logger.warn(`release-due failed: ${e.message}`));
      }, lifecycleIntervalMs);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- cart -----------------------------------------------------------------------------------------------------

  async cart(buyerId: string, shopId?: string) {
    const items = await this.prisma.cartItem.findMany({
      where: { buyerId, ...(shopId ? { sku: { shopId } } : {}) },
      include: { sku: { include: { product: true, inventory: true } } },
      orderBy: { updatedAt: 'asc' },
    });
    return items.map((i) => ({
      skuId: i.sku.externalId,
      productId: i.sku.product.externalId,
      productTitle: i.sku.product.title,
      skuName: i.sku.name,
      sellerSku: i.sku.sellerSku,
      quantity: i.quantity,
      unitPriceVnd: i.sku.priceVnd,
      lineTotalVnd: i.sku.priceVnd * i.quantity,
      available: i.sku.product.status === 'ACTIVATE' && !i.sku.product.isNotForSale && i.sku.status === 'NORMAL' && i.sku.inventory.reduce((n, l) => n + l.quantity, 0) >= i.quantity,
    }));
  }

  /** quantity 0 removes the line. The shop comes from the buyer, never from the request. */
  async setCartItem(buyer: { id: string; shopId: string }, skuExternalId: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_UNITS_PER_SKU) throw new OrderRuleError('invalid_quantity', `quantity must be an integer in [0, ${MAX_UNITS_PER_SKU}]`);
    const sku = await this.prisma.sku.findUnique({ where: { shopId_externalId: { shopId: buyer.shopId, externalId: skuExternalId } } });
    if (!sku) throw new NotFoundException('Unknown SKU in this shop');
    if (quantity === 0) {
      await this.prisma.cartItem.deleteMany({ where: { buyerId: buyer.id, skuId: sku.id } });
      return;
    }
    await this.prisma.cartItem.upsert({
      where: { buyerId_skuId: { buyerId: buyer.id, skuId: sku.id } },
      create: { buyerId: buyer.id, skuId: sku.id, quantity },
      update: { quantity },
    });
  }

  // ---- checkout -------------------------------------------------------------------------------------------------

  /**
   * Creates an UNPAID order and reserves stock. Idempotent per (buyer, checkoutKey): a repeated submit (double click, retry)
   * returns the original order instead of a second one, enforced by a unique constraint, not by a prior lookup alone.
   */
  async checkout(buyer: { id: string; shopId: string }, input: CheckoutInput, requestId?: string): Promise<{ order: OrderRow; replayed: boolean }> {
    const merged = new Map<string, number>();
    for (const it of input.items) {
      if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > MAX_UNITS_PER_SKU) throw new OrderRuleError('invalid_quantity', `quantity must be an integer in [1, ${MAX_UNITS_PER_SKU}]`);
      merged.set(it.skuExternalId, (merged.get(it.skuExternalId) ?? 0) + it.quantity);
    }
    if (merged.size === 0) throw new OrderRuleError('empty_order', 'at least one item is required');
    for (const q of merged.values()) if (q > MAX_UNITS_PER_SKU) throw new OrderRuleError('invalid_quantity', `at most ${MAX_UNITS_PER_SKU} units per SKU`);
    const units = [...merged.values()].reduce((a, b) => a + b, 0);
    if (units > MAX_LINES_PER_ORDER) throw new OrderRuleError('too_many_units', `at most ${MAX_LINES_PER_ORDER} units per order`);

    const existing = await this.findByCheckoutKey(buyer.id, input.checkoutKey);
    if (existing) return { order: existing, replayed: true };

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const shop = await tx.shop.findUniqueOrThrow({ where: { id: buyer.shopId } });
        const skus = await tx.sku.findMany({ where: { shopId: shop.id, externalId: { in: [...merged.keys()] } }, include: { product: true } });
        if (skus.length !== merged.size) throw new OrderRuleError('unknown_sku', 'an item does not exist in this shop');
        for (const s of skus) {
          if (s.product.status !== 'ACTIVATE' || s.product.isNotForSale || s.status !== 'NORMAL') throw new OrderRuleError('not_for_sale', `SKU ${s.externalId} is not on sale`);
        }
        // Lock the inventory rows of these SKUs in a stable order, then pick one warehouse that can fill the whole order.
        const skuIds = skus.map((s) => s.id).sort();
        await tx.$queryRaw`SELECT id FROM "InventoryLevel" WHERE "skuId" IN (${Prisma.join(skuIds)}) ORDER BY id FOR UPDATE`;
        const warehouses = await tx.warehouse.findMany({ where: { shopId: shop.id, effectStatus: 'ENABLED' }, orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] });
        const levels = await tx.inventoryLevel.findMany({ where: { skuId: { in: skuIds } } });
        const warehouse = warehouses.find((w) =>
          skus.every((s) => (levels.find((l) => l.skuId === s.id && l.warehouseId === w.id)?.quantity ?? 0) >= merged.get(s.externalId)!),
        );
        if (!warehouse) throw new OrderRuleError('insufficient_stock', 'not enough stock in a single warehouse for every item');
        for (const s of skus) {
          // guarded decrement: never below zero even if another writer slipped in
          const r = await tx.inventoryLevel.updateMany({ where: { skuId: s.id, warehouseId: warehouse.id, quantity: { gte: merged.get(s.externalId)! } }, data: { quantity: { decrement: merged.get(s.externalId)! } } });
          if (r.count !== 1) throw new OrderRuleError('insufficient_stock', `SKU ${s.externalId} just ran out of stock`);
        }
        await logInventory(
          tx,
          skus.map((s) => {
            const before = levels.find((l) => l.skuId === s.id && l.warehouseId === warehouse.id)?.quantity ?? 0;
            return { shopId: shop.id, skuId: s.id, warehouseId: warehouse.id, before, after: before - merged.get(s.externalId)!, source: 'ORDER' as const, requestId, note: 'checkout reservation' };
          }),
        );

        const now = this.clock.now();
        const orderId = randomUUID();
        const productTotal = skus.reduce((n, s) => n + s.priceVnd * merged.get(s.externalId)!, 0);
        // Phase 09a: validate + take one redemption in THIS transaction (rolls back with the order; guarded against the usage limit).
        const coupon = input.couponCode?.trim()
          ? await reserveCoupon(tx, { shopId: shop.id, buyerId: buyer.id, code: input.couponCode, subtotalVnd: productTotal, now })
          : null;
        const lines: Prisma.OrderLineCreateManyOrderInput[] = [];
        for (const s of skus) {
          for (let u = 0; u < merged.get(s.externalId)!; u++) {
            lines.push({
              id: randomUUID(),
              externalId: numericId('5761', `line:${orderId}:${s.externalId}:${u}`),
              skuId: s.id,
              skuExternalId: s.externalId,
              productExternalId: s.product.externalId,
              productName: s.product.title,
              skuName: s.name,
              sellerSku: s.sellerSku,
              originalPrice: s.priceVnd,
              salePrice: s.priceVnd,
              displayStatus: 'UNPAID',
            });
          }
        }
        if (coupon) {
          // per-line seller_discount: proportional to the line price, integer VND, largest remainder (deterministic), sums to the order discount
          const shares = distributeProportionally(coupon.discountVnd, lines.map((l) => l.salePrice));
          lines.forEach((l, i) => (l.sellerDiscount = shares[i]));
        }
        await tx.order.create({
          data: {
            id: orderId,
            shopId: shop.id,
            externalId: numericId('5760', `order:${orderId}`),
            buyerId: buyer.id,
            status: 'UNPAID',
            createdAt: now,
            updatedAt: now,
            warehouseId: warehouse.id,
            checkoutKey: input.checkoutKey,
            buyerMessage: input.buyerMessage ?? '',
            recipientName: input.recipient.name,
            recipientPhone: input.recipient.phone,
            addressLine: input.recipient.addressLine,
            district: input.recipient.district,
            city: input.recipient.city,
            postalCode: input.recipient.postalCode ?? '',
            currency: shop.currency,
            originalProductPrice: productTotal,
            sellerDiscount: coupon?.discountVnd ?? 0,
            originalShippingFee: this.config.orders.shippingFeeVnd,
            lines: { createMany: { data: lines } },
            audits: { create: { toStatus: 'UNPAID', actor: 'BUYER', note: 'checkout', at: now } },
          },
        });
        if (coupon) await recordCouponUsage(tx, coupon, orderId, now);
        const created = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
        await this.emitter.emit(tx, shop, 'ORDER_STATUS_CHANGE', this.eventData(created), requestId);
        return created;
      }, TX_OPTIONS);
      return { order: order, replayed: false };
    } catch (e) {
      // two concurrent submits with the same key: the unique (buyerId, checkoutKey) constraint picks one winner
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.findByCheckoutKey(buyer.id, input.checkoutKey);
        if (winner) return { order: winner, replayed: true };
      }
      throw e;
    }
  }

  // ---- payment & transitions ------------------------------------------------------------------------------------

  /** Fake payment (a /demo operation, not a TikTok API): UNPAID -> ON_HOLD. Paying twice is a no-op that reports `replayed`. */
  async pay(buyer: { id: string; shopId: string }, orderExternalId: string, requestId?: string): Promise<{ order: OrderRow; replayed: boolean }> {
    const order = await this.ownedByBuyer(buyer, orderExternalId);
    if (order.status !== 'UNPAID') {
      if (order.status === 'CANCELLED') throw new OrderRuleError('order_cancelled', 'a cancelled order cannot be paid');
      return { order, replayed: true };
    }
    const now = this.clock.now();
    const res = await this.transition(order.id, 'ON_HOLD', 'BUYER', {
      note: 'fake payment',
      requestId,
      patch: { paidAt: now, releaseAt: new Date(now.getTime() + this.config.orders.holdMinutes * 60_000), isOnHold: true },
    }).catch((e) => {
      if (e instanceof ConflictException) return null; // lost a race with a concurrent pay/cancel: re-read below
      throw e;
    });
    return { order: res ?? (await this.mustFind(order.id)), replayed: res === null };
  }

  /** Buyer cancel: immediate while UNPAID/ON_HOLD (no approval needed); later it is only a request flag (approval is Phase 07). */
  async buyerCancel(buyer: { id: string; shopId: string }, orderExternalId: string, reason: string, requestId?: string): Promise<OrderRow> {
    const order = await this.ownedByBuyer(buyer, orderExternalId);
    if (order.status === 'UNPAID' || order.status === 'ON_HOLD') {
      return this.transition(order.id, 'CANCELLED', 'BUYER', { note: reason, requestId, cancelReason: reason, initiator: 'BUYER' });
    }
    if (order.status === 'CANCELLED') return order;
    if (order.status !== 'AWAITING_SHIPMENT') throw new OrderRuleError('cancel_not_allowed', `an order in ${order.status} cannot be cancelled by the buyer`);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { buyerRequestedCancel: true, updatedAt: now } });
      await tx.orderAudit.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: order.status, actor: 'BUYER', note: `cancel requested: ${reason}`, at: now } });
    });
    return this.mustFind(order.id);
  }

  /**
   * Compare-and-set state change. `to` must be reachable from the CURRENT status (re-read inside the transaction), so two concurrent callers
   * cannot both succeed. Cancelling releases the reserved stock exactly once.
   */
  async transition(
    orderId: string,
    to: OrderStatus,
    actor: Actor,
    opts: { note?: string; requestId?: string; cancelReason?: string; initiator?: string; patch?: Prisma.OrderUncheckedUpdateManyInput } = {},
  ): Promise<OrderRow> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude });
      if (!current) throw new NotFoundException('Unknown order');
      if (!canTransition(current.status, to)) {
        throw new OrderRuleError('invalid_transition', `${current.status} -> ${to} is not allowed${current.status === 'ON_HOLD' ? ' (an ON_HOLD order cannot be shipped)' : ''}`);
      }
      const now = this.clock.now();
      const data: Prisma.OrderUncheckedUpdateManyInput = { ...(opts.patch ?? {}), status: to, updatedAt: now };
      if (to === 'AWAITING_COLLECTION') data.rtsAt = now;
      if (to === 'IN_TRANSIT') data.collectionAt = now;
      if (to === 'DELIVERED') data.deliveredAt = now;
      if (to === 'COMPLETED') data.completedAt = now;
      if (to === 'CANCELLED') {
        data.cancelledAt = now;
        data.cancelReason = opts.cancelReason ?? opts.note ?? 'cancelled';
        data.cancellationInitiator = opts.initiator ?? (actor === 'SELLER' ? 'SELLER' : actor === 'BUYER' ? 'BUYER' : 'SYSTEM');
        data.buyerRequestedCancel = false;
      }
      const res = await tx.order.updateMany({ where: { id: orderId, status: current.status }, data });
      if (res.count !== 1) throw new ConflictException('The order changed concurrently; retry');
      await tx.orderLine.updateMany({ where: { orderId }, data: { displayStatus: to } });
      if (to === 'CANCELLED') {
        await this.releaseStock(tx, current);
        // Phase 09a: an UNPAID order gives its coupon redemption back (exactly once); after payment the redemption stays used
        if (current.status === 'UNPAID') await releaseCouponForOrder(tx, orderId);
      }
      await tx.orderAudit.create({ data: { orderId, fromStatus: current.status, toStatus: to, actor, note: opts.note ?? '', at: now } });
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: current.shopId } });
      await this.emitter.emit(tx, shop, 'ORDER_STATUS_CHANGE', this.eventData(updated), opts.requestId);
      for (const listener of this.listeners) await listener({ tx, shop, before: current, after: updated, to, actor, now, requestId: opts.requestId });
      return updated;
    }, TX_OPTIONS);
  }

  /** Put the reserved units back exactly once (stockReleased is the guard). */
  private async releaseStock(tx: Prisma.TransactionClient, order: OrderRow): Promise<void> {
    if (!order.warehouseId) return;
    const flag = await tx.order.updateMany({ where: { id: order.id, stockReleased: false }, data: { stockReleased: true } });
    if (flag.count !== 1) return;
    const perSku = new Map<string, number>();
    for (const l of order.lines) if (l.skuId) perSku.set(l.skuId, (perSku.get(l.skuId) ?? 0) + 1);
    for (const [skuId, qty] of perSku) {
      const [row] = await tx.$queryRaw<{ quantity: number }[]>`SELECT quantity FROM "InventoryLevel" WHERE "skuId" = ${skuId} AND "warehouseId" = ${order.warehouseId} FOR UPDATE`;
      await tx.inventoryLevel.updateMany({ where: { skuId, warehouseId: order.warehouseId }, data: { quantity: { increment: qty } } });
      if (row) await logInventory(tx, [{ shopId: order.shopId, skuId, warehouseId: order.warehouseId, before: row.quantity, after: row.quantity + qty, source: 'ORDER', note: `cancel restore ${order.externalId}` }]);
    }
  }

  /** Releases every ON_HOLD order whose hold period (business clock) has elapsed. Returns the released order ids. */
  async releaseDue(): Promise<string[]> {
    const due = await this.prisma.order.findMany({ where: { status: 'ON_HOLD', releaseAt: { lte: this.clock.now() } }, select: { id: true, externalId: true }, orderBy: { seq: 'asc' } });
    const released: string[] = [];
    for (const o of due) {
      try {
        await this.transition(o.id, 'AWAITING_SHIPMENT', 'SYSTEM', { note: 'hold period elapsed' });
        released.push(o.externalId);
      } catch (e) {
        if (!(e instanceof ConflictException) && !(e instanceof OrderRuleError)) throw e; // someone else moved it first
      }
    }
    return released;
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  eventData(o: OrderRow): Record<string, unknown> {
    return { order_id: o.externalId, order_status: o.status, is_on_hold_order: o.isOnHold, update_time: Math.floor(o.updatedAt.getTime() / 1000) };
  }

  async listForBuyer(buyerId: string, shopId?: string): Promise<OrderRow[]> {
    return this.prisma.order.findMany({ where: { buyerId, ...(shopId ? { shopId } : {}) }, orderBy: { seq: 'desc' }, include: orderInclude });
  }

  async listForShop(shopId: string, take = 100): Promise<OrderRow[]> {
    return this.prisma.order.findMany({ where: { shopId }, orderBy: { seq: 'desc' }, take, include: orderInclude });
  }

  async audits(orderId: string) {
    return this.prisma.orderAudit.findMany({ where: { orderId }, orderBy: [{ at: 'asc' }, { createdAt: 'asc' }] });
  }

  /** Test Console lookup by marketplace id; ids are unique per shop, so an id alone can be ambiguous across shops. */
  async findForAdmin(orderRef: string, shopId?: string): Promise<OrderRow> {
    const matches = await this.prisma.order.findMany({
      where: { OR: [{ id: orderRef }, { externalId: orderRef }], ...(shopId ? { shopId } : {}) },
      include: orderInclude,
    });
    if (matches.length === 0) throw new NotFoundException('Unknown order');
    if (matches.length > 1) throw new BadRequestException('Order id is ambiguous across shops; pass shopId');
    return matches[0];
  }

  async findByCheckoutKey(buyerId: string, checkoutKey: string): Promise<OrderRow | null> {
    return this.prisma.order.findUnique({ where: { buyerId_checkoutKey: { buyerId, checkoutKey } }, include: orderInclude });
  }

  private async mustFind(id: string): Promise<OrderRow> {
    return this.prisma.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }

  private async ownedByBuyer(buyer: { id: string; shopId: string }, orderExternalId: string): Promise<OrderRow> {
    const order = await this.prisma.order.findFirst({ where: { buyerId: buyer.id, shopId: buyer.shopId, externalId: orderExternalId }, include: orderInclude });
    if (!order) throw new NotFoundException('Unknown order');
    return order;
  }
}
