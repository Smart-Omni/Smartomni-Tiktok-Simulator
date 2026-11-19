/**
 * SIMULATOR-DEFINED PLACEHOLDER scopes. The contract has no official TikTok scope names (manifest: "scope unresolved"),
 * so these are namespaced `sim.` and must never be treated as TikTok scopes. Later phases add one per operation.
 */
export const SCOPE_AUTHORIZED_SHOPS = 'sim.authorized_shops.read';
export const SCOPE_ORDER_READ = 'sim.order.read';
/** Placeholder scope for the Events API (webhook subscriptions). Tokens issued before Phase 05 lack it and must re-authorize. */
export const SCOPE_EVENT_MANAGE = 'sim.event.manage';
/** Placeholder scope for Update Inventory (official scope names are unresolved). Tokens issued before Phase 06 must re-authorize. */
export const SCOPE_INVENTORY_WRITE = 'sim.inventory.write';
/** Placeholder scopes for fulfillment reads (tracking, package detail, shipping documents) and the ship-package write. */
export const SCOPE_FULFILLMENT_READ = 'sim.fulfillment.read';
export const SCOPE_FULFILLMENT_WRITE = 'sim.fulfillment.write';
/** Placeholder scope for coupon reads (Phase 09a). Tokens issued earlier must re-authorize. */
export const SCOPE_PROMOTION_READ = 'sim.promotion.read';
/** Placeholder scopes for customer-service conversations (official names unresolved). */
export const SCOPE_CONVERSATION_READ = 'sim.conversation.read';
export const SCOPE_CONVERSATION_WRITE = 'sim.conversation.write';
export const SCOPE_PRODUCT_READ = 'sim.product.read';
export const SCOPE_PRODUCT_WRITE = 'sim.product.write';

/** Placeholder scopes for cancellations, returns/refunds, reject reasons and aftersale eligibility (official names unresolved). Older tokens must re-authorize. */
export const SCOPE_AFTERSALE_READ = 'sim.aftersale.read';
export const SCOPE_AFTERSALE_WRITE = 'sim.aftersale.write';

/** Every scope a seeded app is granted by default (override with SEED_APP_SCOPES). Add new phase scopes here ONLY. */
export const DEFAULT_APP_SCOPES = [
  SCOPE_AUTHORIZED_SHOPS,
  SCOPE_PRODUCT_READ,
  SCOPE_PRODUCT_WRITE,
  SCOPE_ORDER_READ,
  SCOPE_EVENT_MANAGE,
  SCOPE_INVENTORY_WRITE,
  SCOPE_CONVERSATION_READ,
  SCOPE_CONVERSATION_WRITE,
  SCOPE_FULFILLMENT_READ,
  SCOPE_FULFILLMENT_WRITE,
  SCOPE_PROMOTION_READ,
  SCOPE_AFTERSALE_READ,
  SCOPE_AFTERSALE_WRITE,
];
