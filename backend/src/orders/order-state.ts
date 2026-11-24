/** Order statuses the simulator stores and moves through. ON_HOLD is deliberately absent (DECISIONS H1): payment goes straight to AWAITING_SHIPMENT. */
export const ORDER_STATUSES = [
  'UNPAID',
  'AWAITING_SHIPMENT',
  'PARTIALLY_SHIPPING',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Every status value the OAS documents (order.detail `status` description), including ON_HOLD, which the simulator never produces.
 * Only used to validate `order_status` filters: filtering by ON_HOLD is valid and simply matches nothing (DECISIONS H5).
 */
export const OAS_ORDER_STATUSES = ['UNPAID', 'ON_HOLD', ...ORDER_STATUSES.filter((s) => s !== 'UNPAID')] as const;

/**
 * Allowed transitions. The OAS lists the statuses but not the transition rules, so this table is the SIMULATOR'S model (unverified):
 * - UNPAID becomes AWAITING_SHIPMENT on payment (no hold period, DECISIONS H1);
 * - CANCELLED is only reachable from UNPAID and AWAITING_SHIPMENT: once shipment is arranged (AWAITING_COLLECTION) or partly shipped
 *   an order can no longer be cancelled, it goes through returns/refunds instead (DECISIONS H14);
 * - DELIVERED is not COMPLETED; COMPLETED is terminal here (Phase 07 models returns as separate aftersale records).
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  UNPAID: ['AWAITING_SHIPMENT', 'CANCELLED'],
  AWAITING_SHIPMENT: ['PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'CANCELLED'],
  PARTIALLY_SHIPPING: ['AWAITING_COLLECTION'],
  AWAITING_COLLECTION: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from as OrderStatus] ?? []).includes(to as OrderStatus);
}

/** Statuses from which a stock reservation is still held (released on cancel). */
export const SHIPPING_STATUSES: readonly OrderStatus[] = ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'PARTIALLY_SHIPPING'];
