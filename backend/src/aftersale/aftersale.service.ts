import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { OrderRuleError, OrdersService, TransitionContext } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { buildReverseStatusUpdateData, WebhookEmitter } from '../webhooks/webhook-emitter.service';

/** Interactive transactions take row locks and do several statements; same budget as the order service. */
const TX_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const;
const DAY_MS = 24 * 3600 * 1000;

/** Statuses are the OAS values (return.search / cancellation.search `*_status` descriptions). */
export const CANCEL = {
  PENDING: 'CANCELLATION_REQUEST_PENDING',
  SUCCESS: 'CANCELLATION_REQUEST_SUCCESS',
  CANCELLED: 'CANCELLATION_REQUEST_CANCELLED',
  COMPLETE: 'CANCELLATION_REQUEST_COMPLETE',
} as const;

export const RETURN = {
  PENDING: 'RETURN_OR_REFUND_REQUEST_PENDING',
  AWAITING_BUYER: 'AWAITING_BUYER_RESPONSE',
  REJECT: 'REFUND_OR_RETURN_REQUEST_REJECT',
  AWAITING_SHIP: 'AWAITING_BUYER_SHIP',
  SHIPPED: 'BUYER_SHIPPED_ITEM',
  REJECT_PACKAGE: 'REJECT_RECEIVE_PACKAGE',
  SUCCESS: 'RETURN_OR_REFUND_REQUEST_SUCCESS',
  CANCEL: 'RETURN_OR_REFUND_REQUEST_CANCEL',
  COMPLETE: 'RETURN_OR_REFUND_REQUEST_COMPLETE',
} as const;

export const RETURN_TYPES = ['REFUND', 'RETURN_AND_REFUND', 'EXCHANGE', 'REPLACEMENT'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

export const ARBITRATION_STATUSES = [
  'NO_ARBITRATION',
  'IN_ARBITRATION',
  'ARBITRATION_WIN',
  'ARBITRATION_LOSS',
] as const;
export type ArbitrationStatus = (typeof ARBITRATION_STATUSES)[number];

/** Rejection reasons offered by Get Reject Reasons. The OAS documents no value list: these names are SIMULATOR choices (unverified). */
export const REJECT_REASONS = [
  { name: 'ITEM_AS_DESCRIBED', text: 'The item matches its description' },
  { name: 'RETURN_WINDOW_EXPIRED', text: 'The request is outside the return window' },
  { name: 'ITEM_USED_OR_DAMAGED', text: 'The returned item is used or damaged' },
  { name: 'ALREADY_SHIPPED', text: 'The order has already been handed to the carrier' },
  { name: 'OTHER', text: 'Other reason' },
];
export const REQUEST_REASONS = ['CHANGED_MIND', 'DAMAGED_ITEM', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'OTHER'];

const requestInclude = {
  lines: { orderBy: [{ externalId: 'asc' }], include: { orderLine: true } },
  order: { include: { buyer: { select: { externalId: true, name: true } } } },
} satisfies Prisma.AftersaleRequestInclude;
export type AftersaleRow = Prisma.AftersaleRequestGetPayload<{ include: typeof requestInclude }>;

type Tx = Prisma.TransactionClient;
type Buyer = { id: string; shopId: string };
type Role = 'BUYER' | 'SELLER' | 'SYSTEM';
type Actor = 'BUYER' | 'SELLER' | 'SYSTEM' | 'OPERATOR';

/** What a unit is worth to the buyer: what was actually paid for it (price minus its discounts). Never below 0. */
export const unitPaid = (l: { salePrice: number; sellerDiscount: number; platformDiscount: number }): number => Math.max(0, l.salePrice - l.sellerDiscount - l.platformDiscount);

/**
 * Cancellations and returns/refunds. Rules worth knowing:
 *  - the ORDER status is never changed by a return (the OAS has no RETURNED order status); only an approved cancellation cancels the order;
 *  - the simulator NEVER adds stock back for a return: SmartOmni Inventory restocks through its own idempotent receipt;
 *  - one unit can be in at most one active request, enforced by a partial unique index (AftersaleLine.orderLineId WHERE active);
 *  - every status change writes a record row and the webhook event in the SAME transaction.
 */
@Injectable()
export class AftersaleService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WebhookEmitter) private readonly emitter: WebhookEmitter,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    this.orders.addTransitionListener((ctx) => this.onOrderTransition(ctx));
  }

  // ---- creation (buyer) -----------------------------------------------------------------------------------------

  /**
   * Seller Cancel Order (OAS CancelOrder). The order transition already runs the aftersale listener in the same
   * transaction, which writes the SELLER CANCEL record, restores stock once and emits both events (DECISIONS DA-7).
   */
  async sellerCancel(shopId: string, orderExternalId: string, reason: string, lineIds: string[] | undefined, items: { skuId: string; quantity: number }[] | undefined, requestId?: string): Promise<AftersaleRow> {
    const order = await this.prisma.order.findFirst({ where: { shopId, externalId: orderExternalId }, include: { lines: true } });
    if (!order) throw new NotFoundException('Unknown order');
    const latest = () => this.prisma.aftersaleRequest.findFirst({ where: { orderId: order.id, kind: 'CANCELLATION' }, orderBy: { seq: 'desc' }, include: requestInclude });
    if (order.status === 'CANCELLED') {
      const prior = await latest();
      if (prior && prior.role === 'SELLER') return prior; // repeated call: same cancel_id
      throw new OrderRuleError('cancel_not_allowed', 'the order is already cancelled by someone else');
    }
    if (!['UNPAID', 'AWAITING_SHIPMENT'].includes(order.status)) throw new OrderRuleError('cancel_not_allowed', `a seller cannot cancel an order in ${order.status}`);
    if (lineIds && (lineIds.length !== order.lines.length || order.lines.some((l) => !lineIds.includes(l.externalId)))) {
      throw new OrderRuleError('partial_cancel_unsupported', 'partial cancellation is not supported for VN: pass every order line item id or none');
    }
    if (items) {
      const perSku = new Map<string, number>();
      for (const l of order.lines) perSku.set(l.skuExternalId, (perSku.get(l.skuExternalId) ?? 0) + 1);
      const asked = new Map<string, number>();
      for (const it of items) asked.set(it.skuId, (asked.get(it.skuId) ?? 0) + it.quantity);
      if (asked.size !== perSku.size || [...perSku].some(([sku, n]) => asked.get(sku) !== n)) {
        throw new OrderRuleError('partial_cancel_unsupported', 'partial cancellation is not supported for VN: skus must cover every unit of the order');
      }
    }
    try {
      await this.orders.transition(order.id, 'CANCELLED', 'SELLER', { note: 'seller cancelled', cancelReason: reason, initiator: 'SELLER', forceRecord: true, requestId });
    } catch (e) {
      if (e instanceof ConflictException) throw new OrderRuleError('cancel_not_allowed', 'the order changed concurrently; retry');
      throw e;
    }
    const created = await latest();
    if (!created) throw new OrderRuleError('cancel_not_allowed', 'the order had no cancellable units');
    return created;
  }

  /** Buyer asks to cancel a PAID order that is still AWAITING_SHIPMENT (needs seller approval). UNPAID cancels are immediate and create no record. */
  async createCancellation(buyer: Buyer, orderExternalId: string, reason: string, requestId?: string): Promise<AftersaleRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({ where: { buyerId: buyer.id, shopId: buyer.shopId, externalId: orderExternalId }, include: { lines: true, buyer: { select: { externalId: true, name: true } } } });
        if (!order) throw new NotFoundException('Unknown order');
        const pending = await tx.aftersaleRequest.findFirst({ where: { orderId: order.id, kind: 'CANCELLATION', status: CANCEL.PENDING }, include: requestInclude });
        if (pending) return pending; // repeated request: same record
        if (order.status !== 'AWAITING_SHIPMENT') throw new OrderRuleError('cancel_not_allowed', `an order in ${order.status} cannot be cancelled with a request`);
        const now = this.clock.now();
        const shipping = order.originalShippingFee - order.shippingFeeDiscount;
        const subtotal = order.lines.reduce((n, l) => n + unitPaid(l), 0);
        const created = await this.insertRequest(tx, {
          shopId: order.shopId, orderId: order.id, kind: 'CANCELLATION', type: 'BUYER_CANCEL', status: CANCEL.PENDING, reason, role: 'BUYER',
          refundSubtotal: subtotal, refundShipping: shipping, lines: order.lines, now,
        });
        await tx.order.update({ where: { id: order.id }, data: { buyerRequestedCancel: true, updatedAt: now } });
        await tx.orderAudit.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: order.status, actor: 'BUYER', note: `cancel requested: ${reason}`, at: now } });
        await this.record(tx, created.id, null, CANCEL.PENDING, 'BUYER', reason, now);
        await this.emit(tx, created, now, requestId);
        return this.mustFind(tx, created.id);
      }, TX_OPTIONS);
    } catch (e) {
      throw this.mapUnitConflict(e);
    }
  }

  /** Return/refund of chosen units of a DELIVERED/COMPLETED order inside the (business-clock) return window. */
  async createReturn(
    buyer: Buyer,
    orderExternalId: string,
    input: { items: { skuId: string; quantity: number }[]; returnType: string; reason: string; sellerProposedReturnType?: string },
    requestId?: string,
  ): Promise<AftersaleRow> {
    return this.createReturnCore({ shopId: buyer.shopId, buyerId: buyer.id, orderExternalId, role: 'BUYER', items: input.items, returnType: input.returnType, reason: input.reason, sellerProposedReturnType: input.sellerProposedReturnType, requestId });
  }

  /** Create Return on behalf of the buyer (OAS CreateReturn): same rules as the buyer path, role SELLER, units by sku or by line id, optional idempotency key and partial refund. */
  async createReturnForBuyer(
    shopId: string,
    orderExternalId: string,
    input: { items?: { skuId: string; quantity: number }[]; lineIds?: string[]; returnType: string; reason: string; refundTotal?: number; idempotencyKey?: string },
    requestId?: string,
  ): Promise<AftersaleRow> {
    return this.createReturnCore({ shopId, orderExternalId, role: 'SELLER', ...input, requestId });
  }

  private async createReturnCore(a: {
    shopId: string;
    buyerId?: string;
    orderExternalId: string;
    role: Role;
    items?: { skuId: string; quantity: number }[];
    lineIds?: string[];
    returnType: string;
    reason: string;
    sellerProposedReturnType?: string;
    refundTotal?: number;
    idempotencyKey?: string;
    requestId?: string;
  }): Promise<AftersaleRow> {
    if (!(RETURN_TYPES as readonly string[]).includes(a.returnType)) {
      throw new OrderRuleError('invalid_return_type', `returnType must be one of ${RETURN_TYPES.join(', ')}`);
    }
    const wanted = new Map<string, number>();
    for (const it of a.items ?? []) {
      if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new OrderRuleError('invalid_quantity', 'quantity must be a positive integer');
      wanted.set(it.skuId, (wanted.get(it.skuId) ?? 0) + it.quantity);
    }
    if (wanted.size === 0 && !a.lineIds?.length) throw new OrderRuleError('empty_request', 'select at least one item');
    const actor: Actor = a.role === 'SELLER' ? 'SELLER' : 'BUYER';
    const existingByKey = async (db: Tx | PrismaService) =>
      a.idempotencyKey ? db.aftersaleRequest.findFirst({ where: { shopId: a.shopId, idempotencyKey: a.idempotencyKey }, include: requestInclude }) : null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({ where: { shopId: a.shopId, externalId: a.orderExternalId, ...(a.buyerId ? { buyerId: a.buyerId } : {}) }, include: { buyer: { select: { externalId: true, name: true } } } });
        if (!order) throw new NotFoundException('Unknown order');
        const prior = await existingByKey(tx);
        if (prior) {
          if (prior.orderId !== order.id) throw new OrderRuleError('idempotency_key_reused', 'idempotency_key was already used for a different order');
          return prior; // replay: same return_id, nothing else changes
        }
        const now = this.clock.now();
        this.assertReturnable(order, now);
        const free = await tx.orderLine.findMany({ where: { orderId: order.id, aftersaleLines: { none: { active: true } } }, orderBy: { externalId: 'asc' } });
        const chosen: typeof free = [];
        if (a.lineIds?.length) {
          for (const id of new Set(a.lineIds)) {
            const unit = free.find((l) => l.externalId === id);
            if (!unit) throw new OrderRuleError('units_unavailable', `order line item ${id} does not exist or is already in an aftersale request`);
            chosen.push(unit);
          }
        } else {
          for (const [skuId, qty] of wanted) {
            const units = free.filter((l) => l.skuExternalId === skuId);
            if (units.length < qty) throw new OrderRuleError('units_unavailable', `only ${units.length} unit(s) of ${skuId} can still be returned (asked ${qty})`);
            chosen.push(...units.slice(0, qty));
          }
        }
        const refundable = chosen.reduce((n, l) => n + unitPaid(l), 0);
        if (a.refundTotal !== undefined && (a.refundTotal < 1 || a.refundTotal > refundable)) throw new OrderRuleError('refund_exceeds_refundable', `refund_total must be between 1 and the refundable amount ${refundable}`);
        const created = await this.insertRequest(tx, {
          shopId: order.shopId,
          orderId: order.id,
          kind: 'RETURN',
          type: a.returnType,
          status: RETURN.PENDING,
          reason: a.reason,
          role: a.role,
          arbitrationStatus: 'NO_ARBITRATION',
          sellerProposedReturnType: a.sellerProposedReturnType,
          idempotencyKey: a.idempotencyKey,
          refundSubtotal: a.refundTotal ?? refundable,
          refundShipping: 0,
          lines: chosen,
          now,
        });
        await this.record(tx, created.id, null, RETURN.PENDING, actor, a.reason, now);
        await this.emit(tx, created, now, a.requestId);
        return this.mustFind(tx, created.id);
      }, TX_OPTIONS);
    } catch (e) {
      // two calls with the same key racing: the loser finds the winner's row
      if (a.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await existingByKey(this.prisma);
        if (winner) return winner;
      }
      throw this.mapUnitConflict(e);
    }
  }

  /** Calculate Refund (OAS CalculateRefund): a pure read using the same numbers a request would store. */
  async calculateRefund(shopId: string, orderExternalId: string, input: { requestType: string; lineIds?: string[]; items?: { skuId: string; quantity: number }[] }) {
    const order = await this.prisma.order.findFirst({ where: { shopId, externalId: orderExternalId }, include: { lines: { orderBy: { externalId: 'asc' }, include: { aftersaleLines: { where: { active: true } } } } } });
    if (!order) throw new NotFoundException('Unknown order');
    const free = order.lines.filter((l) => l.aftersaleLines.length === 0);
    let chosen = free;
    if (input.lineIds?.length) {
      chosen = [];
      for (const id of new Set(input.lineIds)) {
        const unit = free.find((l) => l.externalId === id);
        if (!unit) throw new OrderRuleError('units_unavailable', `order line item ${id} does not exist or is already in an aftersale request`);
        chosen.push(unit);
      }
    } else if (input.items?.length) {
      chosen = [];
      for (const it of input.items) {
        const units = free.filter((l) => l.skuExternalId === it.skuId && !chosen.includes(l));
        if (!Number.isInteger(it.quantity) || it.quantity < 1 || units.length < it.quantity) throw new OrderRuleError('units_unavailable', `cannot refund ${it.quantity} unit(s) of ${it.skuId}`);
        chosen.push(...units.slice(0, it.quantity));
      }
    }
    const subtotal = chosen.reduce((n, l) => n + unitPaid(l), 0);
    const wholeOrder = chosen.length === order.lines.length;
    const shipping = input.requestType === 'CANCEL' || wholeOrder ? Math.max(0, order.originalShippingFee - order.shippingFeeDiscount) : 0;
    return { currency: order.currency, refund_subtotal: String(subtotal), refund_shipping_fee: String(shipping), refund_tax: '0', refund_total: String(subtotal + shipping) };
  }

  /** Buyer withdraws a return that has not been received yet. */
  async buyerCancelReturn(buyer: Buyer, externalId: string, requestId?: string): Promise<AftersaleRow> {
    const req = await this.ownedByBuyer(buyer, externalId, 'RETURN');
    if (req.status === RETURN.CANCEL) return req;
    return this.move(req.id, [RETURN.PENDING, RETURN.AWAITING_SHIP, RETURN.AWAITING_BUYER], RETURN.CANCEL, 'BUYER', 'buyer cancelled the request', { deactivate: true, requestId });
  }

  /** Buyer hands the approved return to the (fake) carrier. */
  async buyerShipBack(buyer: Buyer, externalId: string, requestId?: string): Promise<AftersaleRow> {
    const req = await this.ownedByBuyer(buyer, externalId, 'RETURN');
    if (req.status === RETURN.SHIPPED) return req;
    return this.move(req.id, [RETURN.AWAITING_SHIP], RETURN.SHIPPED, 'BUYER', 'return shipped', { patch: { returnTrackingNumber: `SIMRET${String(Date.now()).slice(-9)}` }, requestId });
  }

  // ---- dispute & arbitration state machine ---------------------------------------------------------------------

  /**
   * Transitions arbitration_status for a return request:
   * NO_ARBITRATION -> IN_ARBITRATION (buyer dispute)
   * IN_ARBITRATION -> ARBITRATION_WIN | ARBITRATION_LOSS (TikTok admin adjudication)
   * Automatically emits REVERSE_STATUS_UPDATE webhook.
   */
  async arbitrate(
    shopId: string,
    externalId: string,
    toStatus: ArbitrationStatus,
    actor: Actor,
    opts: { note?: string; requestId?: string } = {},
  ): Promise<{ request: AftersaleRow; changed: boolean }> {
    const req = await this.byExternal(shopId, externalId, 'RETURN');
    const current = req.arbitrationStatus as ArbitrationStatus;
    if (current === toStatus) return { request: req, changed: false };

    if (current === 'NO_ARBITRATION') {
      if (toStatus !== 'IN_ARBITRATION') {
        throw new OrderRuleError('invalid_arbitration_transition', `cannot jump from NO_ARBITRATION to ${toStatus}; must move to IN_ARBITRATION first`);
      }
    } else if (current === 'IN_ARBITRATION') {
      if (toStatus !== 'ARBITRATION_WIN' && toStatus !== 'ARBITRATION_LOSS') {
        throw new OrderRuleError('invalid_arbitration_transition', `invalid arbitration transition from IN_ARBITRATION to ${toStatus}`);
      }
    } else if (current === 'ARBITRATION_WIN' || current === 'ARBITRATION_LOSS') {
      throw new OrderRuleError('invalid_arbitration_transition', `arbitration is already in terminal state ${current} and cannot transition to ${toStatus}`);
    }

    return await this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      await tx.aftersaleRequest.update({
        where: { id: req.id },
        data: { arbitrationStatus: toStatus, updatedAt: now },
      });
      const note = opts.note ?? (toStatus === 'IN_ARBITRATION' ? 'Buyer raised arbitration dispute' : `TikTok admin adjudicated arbitration: ${toStatus}`);
      await this.record(tx, req.id, current, req.status, actor, note, now);
      await this.emit(tx, req, now, opts.requestId);
      return { request: await this.mustFind(tx, req.id), changed: true };
    }, TX_OPTIONS);
  }

  // ---- seller decisions -----------------------------------------------------------------------------------------

  /** Approve a cancellation. Cancels the ORDER (stock restored once by the order service); the listener closes the request in the same transaction. */
  async approveCancellation(shopId: string, externalId: string, actor: Actor, requestId?: string): Promise<{ request: AftersaleRow; changed: boolean }> {
    const req = await this.byExternal(shopId, externalId, 'CANCELLATION');
    if (req.status === CANCEL.SUCCESS || req.status === CANCEL.COMPLETE) return { request: req, changed: false };
    if (req.status !== CANCEL.PENDING) throw new OrderRuleError('invalid_decision', `a cancellation in ${req.status} cannot be approved`);
    try {
      await this.orders.transition(req.orderId, 'CANCELLED', actor === 'OPERATOR' ? 'TEST_CONSOLE' : 'SELLER', { note: 'cancellation approved', cancelReason: req.reason, initiator: 'BUYER', requestId });
    } catch (e) {
      // lost a race with another approval: the request is SUCCESS then, and approving twice is not an error
      const again = await this.byExternal(shopId, externalId, 'CANCELLATION');
      if (again.status === CANCEL.SUCCESS || again.status === CANCEL.COMPLETE) return { request: again, changed: false };
      throw e;
    }
    return { request: await this.byExternal(shopId, externalId, 'CANCELLATION'), changed: true };
  }

  async rejectCancellation(shopId: string, externalId: string, input: { reason: string; comment?: string }, actor: Actor, requestId?: string): Promise<{ request: AftersaleRow; changed: boolean }> {
    this.assertRejectReason(input.reason);
    const req = await this.byExternal(shopId, externalId, 'CANCELLATION');
    if (req.status === CANCEL.CANCELLED) return { request: req, changed: false };
    const moved = await this.move(req.id, [CANCEL.PENDING], CANCEL.CANCELLED, actor, `rejected: ${input.reason}`, {
      deactivate: true, requestId, patch: { rejectReason: input.reason, rejectComment: input.comment ?? null },
      after: async (tx, now) => {
        await tx.order.update({ where: { id: req.orderId }, data: { buyerRequestedCancel: false, updatedAt: now } });
        await tx.orderAudit.create({ data: { orderId: req.orderId, fromStatus: req.order.status, toStatus: req.order.status, actor: 'SELLER', note: 'cancellation rejected', at: now } });
      },
    });
    return { request: moved, changed: true };
  }

  /**
   * Approve a return/refund. Supported decisions: APPROVE_REFUND (REFUND type), APPROVE_RETURN and APPROVE_RECEIVED_PACKAGE (RETURN_AND_REFUND).
   * When `decision` is omitted it is inferred from the type and the current status.
   */
  async approveReturn(shopId: string, externalId: string, decision: string | undefined, actor: Actor, opts: { idempotencyKey?: string; requestId?: string } = {}): Promise<{ request: AftersaleRow; changed: boolean }> {
    const req = await this.byExternal(shopId, externalId, 'RETURN');
    const d = decision ?? (req.type === 'REFUND' ? 'APPROVE_REFUND' : req.status === RETURN.SHIPPED ? 'APPROVE_RECEIVED_PACKAGE' : 'APPROVE_RETURN');
    const rule = {
      APPROVE_REFUND: { type: 'REFUND', from: RETURN.PENDING, to: RETURN.SUCCESS },
      APPROVE_RETURN: { type: 'RETURN_AND_REFUND', from: RETURN.PENDING, to: RETURN.AWAITING_SHIP },
      APPROVE_RECEIVED_PACKAGE: { type: 'RETURN_AND_REFUND', from: RETURN.SHIPPED, to: RETURN.SUCCESS },
    }[d];
    if (!rule) throw new OrderRuleError('unsupported_decision', `decision ${d} is not modelled by the simulator`);
    if (rule.type !== req.type) throw new OrderRuleError('invalid_decision', `${d} does not apply to a ${req.type} request`);
    return this.decide(req, rule.from, rule.to, actor, d, opts);
  }

  async rejectReturn(shopId: string, externalId: string, input: { decision?: string; reason: string; comment?: string }, actor: Actor, opts: { idempotencyKey?: string; requestId?: string } = {}): Promise<{ request: AftersaleRow; changed: boolean }> {
    this.assertRejectReason(input.reason);
    const req = await this.byExternal(shopId, externalId, 'RETURN');
    const d = input.decision ?? (req.status === RETURN.SHIPPED ? 'REJECT_RECEIVED_PACKAGE' : req.type === 'REFUND' ? 'REJECT_REFUND' : 'REJECT_RETURN');
    const rule = {
      REJECT_REFUND: { type: 'REFUND', from: RETURN.PENDING, to: RETURN.REJECT },
      REJECT_RETURN: { type: 'RETURN_AND_REFUND', from: RETURN.PENDING, to: RETURN.REJECT },
      REJECT_RECEIVED_PACKAGE: { type: 'RETURN_AND_REFUND', from: RETURN.SHIPPED, to: RETURN.REJECT_PACKAGE },
    }[d];
    if (!rule) throw new OrderRuleError('unsupported_decision', `decision ${d} is not modelled by the simulator`);
    if (rule.type !== req.type) throw new OrderRuleError('invalid_decision', `${d} does not apply to a ${req.type} request`);
    return this.decide(req, rule.from, rule.to, actor, `${d}: ${input.reason}`, opts, { rejectReason: input.reason, rejectComment: input.comment ?? null }, true);
  }

  /** Test Console: the refund has been paid out (SUCCESS -> COMPLETE). Works for both kinds. */
  async complete(ref: string, shopId?: string, requestId?: string): Promise<AftersaleRow> {
    const req = await this.findForAdmin(ref, shopId);
    const done = req.kind === 'CANCELLATION' ? CANCEL.COMPLETE : RETURN.COMPLETE;
    if (req.status === done) return req;
    const from = req.kind === 'CANCELLATION' ? CANCEL.SUCCESS : RETURN.SUCCESS;
    return this.move(req.id, [from], done, 'OPERATOR', 'refund completed', { requestId });
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  async listForShop(shopId: string, buyerId?: string): Promise<AftersaleRow[]> {
    return this.prisma.aftersaleRequest.findMany({ where: { shopId, ...(buyerId ? { order: { buyerId } } : {}) }, orderBy: { seq: 'desc' }, take: 200, include: requestInclude });
  }

  async byExternal(shopId: string, externalId: string, kind?: 'CANCELLATION' | 'RETURN'): Promise<AftersaleRow> {
    const r = await this.prisma.aftersaleRequest.findFirst({ where: { shopId, externalId, ...(kind ? { kind } : {}) }, include: requestInclude });
    if (!r) throw new NotFoundException('Unknown aftersale request');
    return r;
  }

  async records(shopId: string, externalId: string) {
    const req = await this.byExternal(shopId, externalId);
    return this.prisma.aftersaleRecord.findMany({ where: { requestId: req.id }, orderBy: [{ at: 'asc' }, { createdAt: 'asc' }] });
  }

  async findForAdmin(ref: string, shopId?: string): Promise<AftersaleRow> {
    const rows = await this.prisma.aftersaleRequest.findMany({ where: { OR: [{ id: ref }, { externalId: ref }], ...(shopId ? { shopId } : {}) }, include: requestInclude });
    if (rows.length === 0) throw new NotFoundException('Unknown aftersale request');
    if (rows.length > 1) throw new BadRequestException('Aftersale id is ambiguous across shops; pass shopId');
    return rows[0];
  }

  /** Which aftersale options each unit of an order has right now (Get Aftersale Eligibility). Unknown/other-shop order -> NotFound. */
  async eligibility(shopId: string, orderExternalId: string, types: string[]) {
    const order = await this.prisma.order.findFirst({ where: { shopId, externalId: orderExternalId }, include: { lines: { orderBy: { externalId: 'asc' }, include: { aftersaleLines: { where: { active: true } } } } } });
    if (!order) throw new NotFoundException('Unknown order');
    const now = this.clock.now();
    const returnable = this.returnBlock(order, now) === null;
    const cancellable = order.status === 'AWAITING_SHIPMENT';
    const bySku = new Map<string, typeof order.lines>();
    for (const l of order.lines) bySku.set(l.skuExternalId, [...(bySku.get(l.skuExternalId) ?? []), l]);
    return [...bySku.entries()].map(([skuId, units]) => {
      const free = units.filter((u) => u.aftersaleLines.length === 0);
      return {
        sku_id: skuId,
        line_item_eligibility: types.map((t) => {
          const open = t === 'CANCEL' ? cancellable : returnable;
          const eligible = open && free.length > 0;
          const why = !open ? (t === 'CANCEL' ? `order is ${order.status}, only AWAITING_SHIPMENT orders can be cancelled` : this.returnBlock(order, now)!) : 'every unit is already in an aftersale request';
          return {
            request_type: t,
            eligible,
            order_line_items_ids: eligible ? free.map((u) => u.externalId) : [],
            available_reason_names: eligible ? REQUEST_REASONS : [],
            // The OAS documents no ineligible codes: -1 is a simulator sentinel, the text carries the reason.
            ...(eligible ? {} : { ineligible_code: -1, ineligible_reason: why }),
          };
        }),
      };
    });
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  /** Reason a delivered order cannot take a return right now, or null when it can. */
  private returnBlock(order: { status: string; deliveredAt: Date | null; completedAt: Date | null }, now: Date): string | null {
    if (order.status !== 'DELIVERED' && order.status !== 'COMPLETED') return `order is ${order.status}, only DELIVERED/COMPLETED orders can be returned`;
    const base = order.deliveredAt ?? order.completedAt;
    if (!base) return 'the order has no delivery time';
    const closes = base.getTime() + this.config.aftersale.returnWindowDays * DAY_MS;
    if (now.getTime() > closes) return `the ${this.config.aftersale.returnWindowDays}-day return window (business clock) closed at ${new Date(closes).toISOString()}`;
    return null;
  }

  private assertReturnable(order: { status: string; deliveredAt: Date | null; completedAt: Date | null }, now: Date): void {
    const block = this.returnBlock(order, now);
    if (block) throw new OrderRuleError(block.includes('window') ? 'return_window_closed' : 'return_not_allowed', block);
  }

  private async insertRequest(
    tx: Tx,
    a: {
      shopId: string;
      orderId: string;
      kind: string;
      type: string;
      status: string;
      reason: string;
      role: Role;
      refundSubtotal: number;
      refundShipping: number;
      lines: { id: string; salePrice: number; sellerDiscount: number; platformDiscount: number }[];
      now: Date;
      arbitrationStatus?: string;
      sellerProposedReturnType?: string;
      idempotencyKey?: string;
    },
  ) {
    const id = randomUUID();
    await tx.aftersaleRequest.create({
      data: {
        id,
        shopId: a.shopId,
        orderId: a.orderId,
        externalId: numericId(a.kind === 'CANCELLATION' ? '5780' : '5790', `aftersale:${id}`),
        kind: a.kind,
        type: a.type,
        status: a.status,
        reason: a.reason,
        role: a.role,
        arbitrationStatus: a.arbitrationStatus ?? 'NO_ARBITRATION',
        sellerProposedReturnType: a.sellerProposedReturnType ?? null,
        idempotencyKey: a.idempotencyKey ?? null,
        refundSubtotal: a.refundSubtotal,
        refundShipping: a.refundShipping,
        refundTotal: a.refundSubtotal + a.refundShipping,
        createdAt: a.now,
        updatedAt: a.now,
        lines: { create: a.lines.map((l) => ({ id: randomUUID(), orderLineId: l.id, externalId: numericId('5791', `aline:${id}:${l.id}`), refundSubtotal: unitPaid(l), active: true })) },
      },
    });
    return { id, kind: a.kind };
  }

  private async record(tx: Tx, requestId: string, from: string | null, to: string, actor: Actor, note: string, at: Date, idempotencyKey?: string): Promise<void> {
    await tx.aftersaleRecord.create({ data: { requestId, fromStatus: from, toStatus: to, actor, note, at, idempotencyKey: idempotencyKey ?? null } });
  }

  /** Webhook for the request's CURRENT status, written inside the caller's transaction. Data fields are provisional (unverified). */
  private async emit(tx: Tx, req: { id: string; kind: string }, now: Date, requestId?: string): Promise<void> {
    const r = await tx.aftersaleRequest.findUniqueOrThrow({ where: { id: req.id }, include: { order: { select: { externalId: true } } } });
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: r.shopId } });
    const common = { order_id: r.order.externalId, update_time: Math.floor(now.getTime() / 1000) };
    if (r.kind === 'CANCELLATION') {
      const data = { ...common, cancel_id: r.externalId, cancel_status: r.status, cancel_type: r.type };
      await this.emitter.emit(tx, shop, 'CANCELLATION_STATUS_CHANGE', data, requestId);
    } else {
      const data = buildReverseStatusUpdateData({
        reverseId: r.externalId,
        orderId: r.order.externalId,
        reverseType: r.type,
        reverseStatus: r.status,
        arbitrationStatus: r.arbitrationStatus ?? 'NO_ARBITRATION',
        updateTime: Math.floor(now.getTime() / 1000),
      });
      await this.emitter.emit(tx, shop, 'RETURN_STATUS_CHANGE', data as unknown as Record<string, unknown>, requestId);
      await this.emitter.emit(tx, shop, 'REVERSE_STATUS_UPDATE', data as unknown as Record<string, unknown>, requestId);
    }
  }

  /** Compare-and-set status change + record + event in one transaction. */
  private async move(
    id: string,
    from: string[],
    to: string,
    actor: Actor,
    note: string,
    opts: { deactivate?: boolean; patch?: Prisma.AftersaleRequestUncheckedUpdateManyInput; requestId?: string; idempotencyKey?: string; after?: (tx: Tx, now: Date) => Promise<void> } = {},
  ): Promise<AftersaleRow> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.aftersaleRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Unknown aftersale request');
      const now = this.clock.now();
      const res = await tx.aftersaleRequest.updateMany({ where: { id, status: { in: from } }, data: { ...(opts.patch ?? {}), status: to, updatedAt: now } });
      if (res.count !== 1) throw new OrderRuleError('invalid_decision', `the request is ${current.status}; this action needs ${from.join(' or ')}`);
      if (opts.deactivate) await tx.aftersaleLine.updateMany({ where: { requestId: id }, data: { active: false } });
      await this.record(tx, id, current.status, to, actor, note, now, opts.idempotencyKey);
      if (opts.after) await opts.after(tx, now);
      await this.emit(tx, current, now, opts.requestId);
      return this.mustFind(tx, id);
    }, TX_OPTIONS);
  }

  /** Shared body of approve/reject for returns: idempotent when the target (or a later) state is already reached. */
  private async decide(
    req: AftersaleRow, from: string, to: string, actor: Actor, note: string, opts: { idempotencyKey?: string; requestId?: string },
    patch?: Prisma.AftersaleRequestUncheckedUpdateManyInput, deactivate = false,
  ): Promise<{ request: AftersaleRow; changed: boolean }> {
    const reached = to === RETURN.SUCCESS ? [RETURN.SUCCESS, RETURN.COMPLETE] : [to];
    if (reached.includes(req.status)) return { request: req, changed: false };
    try {
      const request = await this.move(req.id, [from], to, actor, note, { ...opts, patch, deactivate });
      return { request, changed: true };
    } catch (e) {
      const again = await this.prisma.aftersaleRequest.findUnique({ where: { id: req.id }, include: requestInclude });
      if (again && reached.includes(again.status)) return { request: again, changed: false }; // a concurrent identical decision won
      throw e;
    }
  }

  /** In the order's cancel transaction: close pending cancellation requests, or record a seller/system cancel of a paid order. */
  private async onOrderTransition(ctx: TransitionContext): Promise<void> {
    if (ctx.to !== 'CANCELLED') return;
    const { tx, now } = ctx;
    const actor: Actor = ctx.actor === 'BUYER' ? 'BUYER' : ctx.actor === 'SELLER' ? 'SELLER' : ctx.actor === 'TEST_CONSOLE' ? 'OPERATOR' : 'SYSTEM';
    const pending = await tx.aftersaleRequest.findMany({ where: { orderId: ctx.after.id, kind: 'CANCELLATION', status: CANCEL.PENDING } });
    if (pending.length > 0) {
      for (const p of pending) {
        const r = await tx.aftersaleRequest.updateMany({ where: { id: p.id, status: CANCEL.PENDING }, data: { status: CANCEL.SUCCESS, updatedAt: now } });
        if (r.count !== 1) continue;
        await this.record(tx, p.id, CANCEL.PENDING, CANCEL.SUCCESS, actor, 'order cancelled', now);
        await this.emit(tx, p, now, ctx.requestId);
      }
      return;
    }
    // Buyer cancels of UNPAID orders are immediate and are NOT aftersale records; later cancels by seller/system are.
    if (ctx.actor === 'BUYER') return;
    if (!ctx.forceRecord && ctx.before.status !== 'AWAITING_SHIPMENT') return;
    const lines = await tx.orderLine.findMany({ where: { orderId: ctx.after.id, aftersaleLines: { none: { active: true } } } });
    if (lines.length === 0) return;
    const unpaid = ctx.before.status === 'UNPAID'; // nothing was paid, so nothing is refunded
    const created = await this.insertRequest(tx, {
      shopId: ctx.after.shopId, orderId: ctx.after.id, kind: 'CANCELLATION', type: 'CANCEL', status: CANCEL.SUCCESS, reason: ctx.after.cancelReason ?? 'cancelled', role: actor === 'SELLER' ? 'SELLER' : 'SYSTEM',
      refundSubtotal: unpaid ? 0 : lines.reduce((n, l) => n + unitPaid(l), 0), refundShipping: unpaid ? 0 : ctx.after.originalShippingFee - ctx.after.shippingFeeDiscount, lines, now,
    });
    await this.record(tx, created.id, null, CANCEL.SUCCESS, actor, ctx.after.cancelReason ?? 'cancelled', now);
    await this.emit(tx, created, now, ctx.requestId);
  }

  private assertRejectReason(reason: string): void {
    if (!REJECT_REASONS.some((r) => r.name === reason)) throw new OrderRuleError('invalid_reject_reason', `reject_reason must be one of ${REJECT_REASONS.map((r) => r.name).join(', ')} (see Get Reject Reasons)`);
  }

  private mapUnitConflict(e: unknown): unknown {
    // the partial unique index on AftersaleLine(orderLineId) WHERE active: a concurrent request got the unit first
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new ConflictException({ code: 'unit_already_requested', message: 'a unit of this order is already in an active aftersale request' });
    return e;
  }

  private async ownedByBuyer(buyer: Buyer, externalId: string, kind: 'CANCELLATION' | 'RETURN'): Promise<AftersaleRow> {
    const r = await this.prisma.aftersaleRequest.findFirst({ where: { shopId: buyer.shopId, externalId, kind, order: { buyerId: buyer.id } }, include: requestInclude });
    if (!r) throw new NotFoundException('Unknown aftersale request');
    return r;
  }

  private async mustFind(tx: Tx, id: string): Promise<AftersaleRow> {
    return tx.aftersaleRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
  }
}
