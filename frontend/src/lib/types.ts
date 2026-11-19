/**
 * Response shapes of the /demo API used by the Tiptop Shop screens (see docs/openapi.json).
 * Only the fields the screens need; amounts are integer VND.
 */

export type Role = 'SELLER' | 'BUYER';

export interface DemoSession {
  sessionToken: string;
  role: Role;
  shopId: string;
  buyerId: string | null;
  expiresAt: string;
}

export interface Identities {
  sellers: { id: string; name: string; shops: { id: string; name: string }[] }[];
  buyers: { id: string; name: string; shopId: string }[];
}

/** Body of POST /demo/sessions. */
export type SignInIdentity = { role: 'SELLER'; sellerId: string; shopId?: string } | { role: 'BUYER'; buyerId: string };

/** GET /demo/me. `buyer` is null for SELLER sessions. */
export interface Me {
  role: Role;
  shop: { id: string; name: string; region: string; currency: string; status: string };
  buyer: { id: string; name: string; city: string } | null;
}

export interface Shop {
  id: string;
  name: string;
  region: string;
  currency: string;
  status: string;
  warehouses: { id: string; code: string; name: string; city: string }[];
}

export interface Sku {
  id: string;
  name: string;
  attributeName: string;
  priceVnd: number;
  available: boolean;
  stock: number;
}

export interface StorefrontProduct {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  /** All real image URLs (or the single placeholder). Optional for older API responses. */
  images?: string[];
  minPriceVnd: number;
  maxPriceVnd: number;
  skus: Sku[];
}

/** Seller catalog SKU. `id` is the row id used by PATCH catalog/skus/{id}; `externalId` is the marketplace id. */
export interface CatalogSku {
  id: string;
  externalId: string;
  sellerSku: string;
  name: string;
  attributeName: string;
  priceVnd: number;
  /** NORMAL or DEACTIVATED. */
  status: string;
  stock: { warehouseId: string; warehouseName: string; quantity: number }[];
  totalStock: number;
}

/** Seller catalog product. `id` is the row id used by the catalog write endpoints. */
export interface CatalogProduct {
  id: string;
  externalId: string;
  title: string;
  description: string;
  /** DRAFT, ACTIVATE, SELLER_DEACTIVATED, DELETED, ... */
  status: string;
  isNotForSale: boolean;
  skus: CatalogSku[];
}

export interface Catalog {
  currency: string;
  warehouses: { externalId: string; name: string; city?: string; isDefault?: boolean }[];
  items: CatalogProduct[];
}

export interface InventoryHistory {
  changes: { seq: number; sku: string; sellerSku: string; warehouse: string; warehouseName: string; before: number; after: number; source: string; noop: boolean; requestId: string | null; note: string | null; at: string }[];
  attempts: { seq: number; product: string; outcome: string; itemsTotal: number; itemsApplied: number; itemsFailed: number; requestId: string | null; at: string }[];
}

export interface CartItem {
  skuId: string;
  productId: string;
  productTitle: string;
  skuName: string;
  sellerSku: string;
  quantity: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  /** Product on sale, SKU NORMAL and stock >= quantity. */
  available: boolean;
}

export interface Cart {
  currency: string;
  items: CartItem[];
  totalVnd: number;
}

export type OrderStatus =
  | 'UNPAID'
  | 'ON_HOLD'
  | 'AWAITING_SHIPMENT'
  | 'PARTIALLY_SHIPPING'
  | 'AWAITING_COLLECTION'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Recipient {
  name: string;
  phone: string;
  addressLine: string;
  district: string;
  city: string;
  postalCode?: string | null;
}

export interface OrderAmounts {
  currency: string;
  productTotalVnd: number;
  sellerDiscountVnd: number;
  platformDiscountVnd: number;
  subTotalVnd: number;
  shippingFeeVnd: number;
  taxVnd: number;
  totalVnd: number;
}

export interface OrderItem {
  skuId: string;
  productId: string;
  productName: string;
  skuName: string;
  sellerSku: string;
  unitPriceVnd: number;
  quantity: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  releaseAt: string | null;
  cancelReason: string | null;
  buyerRequestedCancel: boolean;
  recipient: Recipient;
  buyer: { id: string; name: string };
  amounts: OrderAmounts;
  items: OrderItem[];
}

export interface OrderHistoryEntry {
  from: OrderStatus | null;
  to: OrderStatus;
  actor: string;
  note: string | null;
  at: string;
}

export interface CheckoutRequest {
  /** Client-generated idempotency key, 8-100 chars. */
  checkoutKey: string;
  /** If omitted the whole cart is used. */
  items?: { skuId: string; quantity: number }[];
  recipient?: Recipient;
  buyerMessage?: string;
  couponCode?: string;
}

/** TO_FULFILL, PROCESSING, FULFILLING, COMPLETED or CANCELLED. */
export type PackageStatus = string;

export interface Package {
  id: string;
  status: PackageStatus;
  trackingNumber: string | null;
  provider: string;
  /** Only present in the seller view. */
  canArrange?: boolean;
}

export interface TrackingEvent {
  status: string;
  description: string;
  at: string;
}

export interface Fulfillment {
  orderId: string;
  orderStatus: OrderStatus;
  package: Package | null;
  canArrange?: boolean;
  blockedReason: string | null;
  tracking: TrackingEvent[];
}

export type ShippingDocumentType = 'SHIPPING_LABEL' | 'PACKING_SLIP' | 'SHIPPING_LABEL_AND_PACKING_SLIP';

export interface ShippingDocument {
  documentType: ShippingDocumentType;
  trackingNumber: string;
  url: string;
}

export interface Aftersale {
  id: string;
  orderId: string;
  kind: string;
  type: string;
  status: string;
  reason: string;
  role: string;
  rejectReason: string | null;
  returnTrackingNumber: string | null;
  buyer: { id: string; name: string };
  refund: { subtotalVnd: number; shippingVnd: number; totalVnd: number };
  createdAt: string;
  updatedAt: string;
  items: { skuId: string; productName: string; skuName: string; quantity: number }[];
}

export interface AftersaleList {
  items: Aftersale[];
  requestReasons: string[];
  rejectReasons: { name: string; text: string }[];
}

export interface ReturnRequest {
  orderId: string;
  items: { skuId: string; quantity: number }[];
  returnType: 'REFUND' | 'RETURN_AND_REFUND';
  reason?: string;
}

export interface Coupon {
  id: string;
  title: string;
  promoCode: string | null;
  status: string;
  discountType: string;
  amountOffVnd: number | null;
  percentage: number | null;
  maxDiscountVnd: number | null;
  discountText: string;
  minSpendVnd: number | null;
  startAt: string;
  endAt: string;
  redemptionLimit: number | null;
  redeemedCount: number;
  audience: string;
}

export interface ChatMessage {
  id: string;
  index: number;
  type: string;
  /** BUYER, SHOP, CUSTOMER_SERVICE or SYSTEM. */
  role: string;
  roleLabel: string;
  nickname: string;
  at: string;
  text: string | null;
  supported: boolean;
}

export interface Conversation {
  id: string;
  externalId: string;
  buyerNickname: string;
  unread: number;
  canSendMessage: boolean;
  latest: ChatMessage | null;
  updatedAt: string;
}

export interface Conversations {
  supportedTypes: string[];
  unsupported: string;
  items: Conversation[];
}
