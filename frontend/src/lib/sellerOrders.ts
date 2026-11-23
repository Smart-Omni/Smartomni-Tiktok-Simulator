import type { OrderStatus } from './types';

/** Seller Center order rules, taken from the former /seller Orders and Shipping tabs. */

export type SellerOrderTab = 'all' | 'unpaid' | 'to-ship' | 'shipped' | 'completed' | 'cancelled';

export const sellerOrderTabs: { key: SellerOrderTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'to-ship', label: 'To ship' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** Orders per Manage orders tab; Seller Center home uses the same numbers for its to-do list. */
export function countByTab(orders: { status: OrderStatus }[]): Record<SellerOrderTab, number> {
  const counts: Record<SellerOrderTab, number> = { all: orders.length, unpaid: 0, 'to-ship': 0, shipped: 0, completed: 0, cancelled: 0 };
  for (const o of orders) counts[sellerTabOf(o.status)] += 1;
  return counts;
}

export function sellerTabOf(status: OrderStatus): Exclude<SellerOrderTab, 'all'> {
  switch (status) {
    case 'UNPAID':
      return 'unpaid';
    case 'AWAITING_SHIPMENT':
    case 'AWAITING_COLLECTION':
      return 'to-ship';
    case 'PARTIALLY_SHIPPING':
    case 'IN_TRANSIT':
      return 'shipped';
    case 'DELIVERED':
    case 'COMPLETED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
  }
}

export type SellerAction = 'arrange' | 'label' | 'advance' | 'cancel';

/** Statuses that have a package (and so a fulfillment view worth loading). */
export const hasPackage = (status: OrderStatus) => ['AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(status);

/**
 * Arrange shipment only from AWAITING_SHIPMENT; the fake carrier advances AWAITING_COLLECTION -> IN_TRANSIT -> DELIVERED;
 * a label exists once there is a tracking number; the seller can cancel until the parcel is arranged.
 */
export function sellerActionsFor(status: OrderStatus, hasTracking: boolean): SellerAction[] {
  const actions: SellerAction[] = [];
  if (status === 'AWAITING_SHIPMENT') actions.push('arrange');
  if (hasTracking && status !== 'CANCELLED') actions.push('label');
  if (status === 'AWAITING_COLLECTION' || status === 'IN_TRANSIT') actions.push('advance');
  if (status === 'UNPAID' || status === 'AWAITING_SHIPMENT') actions.push('cancel');
  return actions;
}

/** Aftersale statuses waiting for the seller (same list as the former /seller Returns tab). */
export const OPEN_AFTERSALE = ['RETURN_OR_REFUND_REQUEST_PENDING', 'BUYER_SHIPPED_ITEM', 'CANCELLATION_REQUEST_PENDING'];

/** What "Simulate carrier" does next. */
export const advanceHint = (status: OrderStatus) => (status === 'AWAITING_COLLECTION' ? 'Carrier collects the parcel' : 'Parcel is delivered');
