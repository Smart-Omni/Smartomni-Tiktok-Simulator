export const shopPath = (id: string): string => `/shop/${encodeURIComponent(id)}`;
/** Product page URL. Marketplace products carry their shop; guest mock products only have an id. */
export const productPath = (p: { id: string; shop?: { id: string } }): string =>
  p.shop?.id ? `/product/${encodeURIComponent(p.shop.id)}/${encodeURIComponent(p.id)}` : `/product/${encodeURIComponent(p.id)}`;
