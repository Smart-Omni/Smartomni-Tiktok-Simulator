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

/** Customers returned by GET /demo/shops/{shopId}/buyers. */
export interface ShopBuyer {
  id: string;
  name: string;
  city: string;
}

export interface Sku {
  id: string;
  name: string;
  attributeName: string;
  priceVnd: number;
  available: boolean;
  stock: number;
}

export interface ShopRef {
  id: string;
  name: string;
}

export interface StorefrontProduct {
  /** Set by the marketplace catalog (GET /demo/catalog); absent on the per-shop storefront. */
  shop?: ShopRef;
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
  /** Listing fields (optional: older payloads and fixtures do not carry them). */
  images?: ProductImage[];
  categoryId?: string | null;
  categoryPath?: { id: string; name: string }[];
  brandId?: string | null;
  productAttributes?: ProductAttribute[];
  packageWeight?: PackageWeight | null;
  packageDimensions?: PackageDimensions | null;
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

/** One shop's part of the marketplace cart (GET /demo/cart). */
export interface CartShopGroup {
  shop: ShopRef;
  items: CartItem[];
  shopTotalVnd: number;
}

export interface MarketplaceCart {
  currency: string;
  shops: CartShopGroup[];
  totalVnd: number;
  itemCount: number;
}

/** The simulator has no ON_HOLD: payment moves an order straight to AWAITING_SHIPMENT (DECISIONS H1). */
export type OrderStatus =
  | 'UNPAID'
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
  /** Shop that sold the order. Present on every /demo order response. */
  shopId?: string;
  shop?: ShopRef;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  cancelReason: string | null;
  buyerRequestedCancel: boolean;
  recipient: Recipient;
  buyer: { id: string; name: string };
  amounts: OrderAmounts;
  items: OrderItem[];
}

/** One audit row. Statuses are raw strings: history written before ON_HOLD was removed may still contain it (DECISIONS H12). */
export interface OrderHistoryEntry {
  from: string | null;
  to: string;
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
  arbitrationStatus: 'NO_ARBITRATION' | 'IN_ARBITRATION' | 'ARBITRATION_WIN' | 'ARBITRATION_LOSS';
  /** Optional for older responses; supplied by the API when a seller proposal exists. */
  sellerProposedReturnType?: string | null;
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

/** Buyer response is already filtered for eligibility by the API. */
export interface BuyerCoupon {
  id: string;
  title: string;
  promoCode: string;
  discountText: string;
  minSpendVnd: number | null;
  endAt: string;
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

/** Phase 09c: a batch of single-use promo codes (GET /demo/shops/:shopId/coupon-batches). */
export interface CouponBatch {
  id: string;
  title: string;
  status: string;
  discountType: string;
  amountOffVnd: number | null;
  percentage: number | null;
  maxDiscountVnd: number | null;
  discountText: string;
  minSpendVnd: number | null;
  audience: string;
  quantity: number;
  redeemed: number;
  startAt: string;
  endAt: string;
  createdAt: string;
}

export interface CouponBatchCode {
  /** Coupon marketplace id (the coupon_id SmartOmni sees). */
  id: string;
  promoCode: string;
  redeemedCount: number;
  status: string;
}

export interface CouponBatchDetail {
  batch: CouponBatch;
  codes: CouponBatchCode[];
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

/** Uploaded product image (POST /demo/shops/{shopId}/media/images). `uri` goes into a product's `images`. */
export interface UploadedImage {
  uri: string;
  url: string;
  width: number;
  height: number;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ProductImage {
  uri: string;
  url: string;
  width: number | null;
  height: number | null;
}

/** Category tree node (GET .../catalog/categories). Only leaves can hold products. */
export interface CategoryNode {
  id: string;
  name: string;
  isLeaf: boolean;
  children: CategoryNode[];
}

export interface CategoryAttribute {
  id: string;
  name: string;
  isRequired: boolean;
  isMultipleSelection: boolean;
  /** Free-text values allowed (otherwise only `values`). */
  isCustomizable: boolean;
  values: { id: string; name: string }[];
}

export interface CategoryRules {
  packageDimensionsRequired: boolean;
  sizeChartSupported: boolean;
  codSupported: boolean;
}

export interface Brand {
  id: string;
  name: string;
  authorized: boolean;
}

/** A product attribute as stored and sent: listed values carry their `id`, custom ones only a `name`. */
export interface ProductAttribute {
  id: string;
  name?: string;
  values: { id?: string; name?: string }[];
}

export interface PackageWeight {
  value: number;
  unit: string;
}

export interface PackageDimensions {
  length: number;
  width: number;
  height: number;
  unit: string;
}

/** Listing fields of the create/edit product body (null clears a stored value). */
export interface ProductListingBody {
  categoryId: string;
  brandId: string | null;
  images: string[];
  productAttributes: ProductAttribute[];
  packageWeight: { value: number; unit: 'KILOGRAM' | 'POUND' } | null;
  packageDimensions: { length: number; width: number; height: number; unit: 'CENTIMETER' | 'INCH' } | null;
}
