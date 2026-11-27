import { api } from '../../lib/api';

export interface SandboxProducts {
  shop_id: string;
  products: { product_id: string; title: string; sku_list: { id: string; seller_sku: string; price: number; stock_count: number }[] }[];
  limits: { max_quantity_per_sku: number; max_order_count: number };
}
export interface SandboxOrderInput {
  shopId: string;
  items: { product_id: string; sku_id: string; quantity: number }[];
  order_count: number;
  pay: boolean;
  payment_method?: string;
}
export interface SandboxResult {
  created: { order_id: string; status: string }[];
  failed: { index: number; error: string }[];
  request_id: string | null;
}
export interface OrderAudit {
  orderId: string;
  status: string;
  history: { from: string | null; to: string; actor: string; note: string | null; at: string }[];
}
export type ArbitrationDecision = 'IN_ARBITRATION' | 'ARBITRATION_WIN' | 'ARBITRATION_LOSS';

// Additional Admin integrations. Existing api.ts and endpoint functions remain unchanged.
export const getSandboxProducts = (shopId: string) =>
  api<SandboxProducts>(`/test-admin/sandbox/products?shopId=${encodeURIComponent(shopId)}`);
export const createSandboxOrders = (body: SandboxOrderInput) =>
  api<SandboxResult>('/test-admin/sandbox/orders', { method: 'POST', body });
export const getOrderAudit = (shopId: string, orderRef: string) =>
  api<OrderAudit>(`/test-admin/orders/${encodeURIComponent(orderRef)}/audit?shopId=${encodeURIComponent(shopId)}`);
export interface OrderTransitionResult {
  id: string;
  from: string;
  status: string;
  transitioned: boolean;
  updatedAt: string;
}
/** Without `to` the API moves the order one happy-path step (fulfillment included); a terminal order stays as it is. */
export const transitionOrder = (shopId: string, orderRef: string, to?: string) =>
  api<OrderTransitionResult>(`/test-admin/orders/${encodeURIComponent(orderRef)}/transition`, { method: 'POST', body: { ...(to ? { to } : {}), shopId } });

export interface LoyaltyOrder {
  label: string;
  orderId: string;
  status: string;
  completedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
  amountsVnd: { productTotal: number; sellerDiscount: number; platformDiscount: number; subTotal: number; shippingFee: number; tax: number; total: number };
}
export interface LoyaltyOrdersResult {
  shopId: string;
  thresholdDays: number;
  note: string;
  orders: LoyaltyOrder[];
}
export const createLoyaltyOrders = (body: { shopId: string; thresholdDays: number; buyerId?: string }) =>
  api<LoyaltyOrdersResult>('/test-admin/scenarios/loyalty-orders', { method: 'POST', body });

export const arbitrateAftersale = (shopId: string, ref: string, arbitration_status: ArbitrationDecision, note: string) =>
  api<{ id: string; arbitration_status: ArbitrationDecision; changed: boolean }>(`/test-admin/aftersale/${encodeURIComponent(ref)}/arbitration`, {
    method: 'POST', body: { shopId, arbitration_status, note },
  });
