/**
 * Order statuses a test may force next. Mirrors backend/src/orders/order-state.ts; the API is the authority and refuses
 * anything else with 400. Used by the Test Console and the Seller Center "Force status" menu.
 */
export const ORDER_NEXT: Record<string, string[]> = {
  UNPAID: ['AWAITING_SHIPMENT', 'CANCELLED'],
  AWAITING_SHIPMENT: ['PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'CANCELLED'],
  PARTIALLY_SHIPPING: ['AWAITING_COLLECTION'],
  AWAITING_COLLECTION: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const orderStatusLabel = (status: string) => status.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
