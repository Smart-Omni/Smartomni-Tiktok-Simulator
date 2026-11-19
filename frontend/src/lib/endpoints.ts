import { api } from './api';
import type {
  AftersaleList,
  Aftersale,
  Cart,
  Catalog,
  ChatMessage,
  CheckoutRequest,
  Conversation,
  Conversations,
  Coupon,
  DemoSession,
  Fulfillment,
  Identities,
  InventoryHistory,
  MarketplaceCart,
  Me,
  Order,
  OrderHistoryEntry,
  ReturnRequest,
  ShippingDocument,
  ShopRef,
  ShippingDocumentType,
  Shop,
  SignInIdentity,
  StorefrontProduct,
} from './types';

/** One function per /demo endpoint used by the Tiptop Shop screens. Shop-scoped calls take the signed-in session. */

const shop = (s: DemoSession, path = '') => `/demo/shops/${encodeURIComponent(s.shopId)}${path}`;
const id = encodeURIComponent;
const auth = (s: DemoSession) => ({ demoSession: s.sessionToken });

/**
 * A buyer session works in every shop: the shop is taken from the URL. Use this to point a shop-scoped call
 * at a shop other than the session's default one, e.g. `getCart(inShop(buyer, product.shop.id))`.
 */
export const inShop = (s: DemoSession, shopId: string): DemoSession => ({ ...s, shopId });

// Sessions
export const getIdentities = () => api<Identities>('/demo/identities');
export const createSession = (identity: SignInIdentity) => api<DemoSession>('/demo/sessions', { method: 'POST', body: identity });
export const getMe = (s: DemoSession) => api<Me>('/demo/me', auth(s));
export const endSession = (s: DemoSession) => api<void>('/demo/sessions/current', { method: 'DELETE', ...auth(s) });

// Shop (seller)
export const getShop = (s: DemoSession) => api<Shop>(shop(s), auth(s));
export const getCatalog = (s: DemoSession) => api<Catalog>(shop(s, '/catalog'), auth(s));
export const getCoupons = (s: DemoSession) => api<{ items: Coupon[] }>(shop(s, '/coupons'), auth(s));
export const listConversations = (s: DemoSession) => api<Conversations>(shop(s, '/chat/conversations'), auth(s));

// Storefront (buyer)
export const listStorefrontProducts = (s: DemoSession) =>
  api<{ currency: string; items: StorefrontProduct[] }>(shop(s, '/storefront/products'), auth(s));
export const getStorefrontProduct = (s: DemoSession, productId: string) =>
  api<{ currency: string; product: StorefrontProduct }>(shop(s, `/storefront/products/${id(productId)}`), auth(s));

// Marketplace (buyer): products, cart and orders of every shop
const PAGE = 100;
const MAX_PAGES = 20;
/** Every on-sale product of every active shop (GET /demo/catalog, public), following the cursor. */
export async function listMarketplaceProducts(): Promise<StorefrontProduct[]> {
  const items: StorefrontProduct[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: { items: StorefrontProduct[]; nextCursor: string | null } = await api(`/demo/catalog?limit=${PAGE}${cursor ? `&cursor=${id(cursor)}` : ''}`);
    items.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}
export const getMarketplaceProduct = (shopId: string, productId: string) =>
  api<{ currency: string; shop: ShopRef; product: StorefrontProduct }>(`/demo/catalog/${id(shopId)}/${id(productId)}`);
export const getMarketplaceCart = (s: DemoSession) => api<MarketplaceCart>('/demo/cart', auth(s));
export const listBuyerOrders = (s: DemoSession) => api<{ items: Order[] }>('/demo/buyer/orders', auth(s));

// Cart and checkout (buyer)
export const getCart = (s: DemoSession) => api<Cart>(shop(s, '/cart'), auth(s));
/** quantity 0 removes the line. */
export const setCartItem = (s: DemoSession, skuId: string, quantity: number) =>
  api<Cart>(shop(s, '/cart/items'), { method: 'PUT', body: { skuId, quantity }, ...auth(s) });
export const checkout = (s: DemoSession, body: CheckoutRequest) =>
  api<{ replayed: boolean; order: Order }>(shop(s, '/checkout'), { method: 'POST', body, ...auth(s) });
export const payOrder = (s: DemoSession, orderId: string) =>
  api<{ replayed: boolean; order: Order }>(shop(s, `/orders/${id(orderId)}/pay`), { method: 'POST', ...auth(s) });

// Orders (both roles)
export const listOrders = (s: DemoSession) => api<{ items: Order[] }>(shop(s, '/orders'), auth(s));
export const getOrder = (s: DemoSession, orderId: string) =>
  api<{ order: Order; history: OrderHistoryEntry[] }>(shop(s, `/orders/${id(orderId)}`), auth(s));
export const cancelOrder = (s: DemoSession, orderId: string, reason?: string) =>
  api<{ order: Order }>(shop(s, `/orders/${id(orderId)}/cancel`), { method: 'POST', body: reason ? { reason } : {}, ...auth(s) });
export const getFulfillment = (s: DemoSession, orderId: string) => api<Fulfillment>(shop(s, `/orders/${id(orderId)}/fulfillment`), auth(s));

// Fulfillment (seller)
export const arrangeShipment = (s: DemoSession, orderId: string) =>
  api<Fulfillment>(shop(s, `/orders/${id(orderId)}/arrange-shipment`), { method: 'POST', ...auth(s) });
export const advanceShipment = (s: DemoSession, orderId: string) =>
  api<Fulfillment>(shop(s, `/orders/${id(orderId)}/advance-shipment`), { method: 'POST', ...auth(s) });
export const getShippingLabel = (s: DemoSession, orderId: string, documentType: ShippingDocumentType = 'SHIPPING_LABEL') =>
  api<ShippingDocument>(shop(s, `/orders/${id(orderId)}/shipping-label`), { method: 'POST', body: { documentType }, ...auth(s) });

// Aftersale
export const listAftersale = (s: DemoSession) => api<AftersaleList>(shop(s, '/aftersale'), auth(s));
export const requestReturn = (s: DemoSession, body: ReturnRequest) =>
  api<{ request: Aftersale }>(shop(s, '/aftersale/returns'), { method: 'POST', body, ...auth(s) });
export const requestCancellation = (s: DemoSession, orderId: string, reason?: string) =>
  api<{ request: Aftersale }>(shop(s, '/aftersale/cancellations'), { method: 'POST', body: { orderId, ...(reason ? { reason } : {}) }, ...auth(s) });

// Seller Center writes (same paths and bodies as the legacy SellerCatalog, aftersale/coupons/chat/inventory seller tabs)
type Body = Record<string, unknown>;
export const createProduct = (s: DemoSession, body: Body) => api(shop(s, '/catalog/products'), { method: 'POST', body, ...auth(s) });
/** `productRowId` is CatalogProduct.id. */
export const patchProduct = (s: DemoSession, productRowId: string, body: Body) =>
  api(shop(s, `/catalog/products/${id(productRowId)}`), { method: 'PATCH', body, ...auth(s) });
export const deleteProduct = (s: DemoSession, productRowId: string) => api(shop(s, `/catalog/products/${id(productRowId)}`), { method: 'DELETE', ...auth(s) });
export const addSku = (s: DemoSession, productRowId: string, body: Body) =>
  api(shop(s, `/catalog/products/${id(productRowId)}/skus`), { method: 'POST', body, ...auth(s) });
/** `skuRowId` is CatalogSku.id; body is one of { priceVnd } | { stock: { [warehouseExternalId]: n } } | { status }. */
export const patchSku = (s: DemoSession, skuRowId: string, body: Body) => api(shop(s, `/catalog/skus/${id(skuRowId)}`), { method: 'PATCH', body, ...auth(s) });
export const getInventoryHistory = (s: DemoSession) => api<InventoryHistory>(shop(s, '/inventory/history'), auth(s));

export const approveAftersale = (s: DemoSession, requestId: string) => api(shop(s, `/aftersale/${id(requestId)}/approve`), { method: 'POST', body: {}, ...auth(s) });
export const rejectAftersale = (s: DemoSession, requestId: string, reason: string) =>
  api(shop(s, `/aftersale/${id(requestId)}/reject`), { method: 'POST', body: { reason }, ...auth(s) });

export const createCoupon = (s: DemoSession, body: Body) => api(shop(s, '/coupons'), { method: 'POST', body, ...auth(s) });
export const patchCoupon = (s: DemoSession, couponId: string, body: Body) => api(shop(s, `/coupons/${id(couponId)}`), { method: 'PATCH', body, ...auth(s) });

export const getConversationMessages = (s: DemoSession, conversationId: string) =>
  api<{ conversation: Conversation; items: ChatMessage[] }>(shop(s, `/chat/conversations/${id(conversationId)}/messages`), auth(s));
export const sendConversationMessage = (s: DemoSession, conversationId: string, text: string) =>
  api(shop(s, `/chat/conversations/${id(conversationId)}/messages`), { method: 'POST', body: { text }, ...auth(s) });
/** Buyer without a conversation yet: writes to the shop (creates the conversation). */
export const sendShopMessage = (s: DemoSession, text: string) => api(shop(s, '/chat/messages'), { method: 'POST', body: { text }, ...auth(s) });
