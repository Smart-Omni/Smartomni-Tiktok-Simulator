/** Router state for /checkout: the cart lines to buy (from Cart "Check out" or Product "Buy now"). */
export interface CheckoutState {
  items: { shopId: string; skuId: string; quantity: number }[];
}

/** The cart API accepts 1..20 per line. */
export const MAX_PER_LINE = 20;
