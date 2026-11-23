/** Limits of the /demo catalog request schemas. */
export const MAX_SKUS = 100;
export const MAX_PRICE = 2_000_000_000;
export const MAX_STOCK = 99_999;
export const wholeNumber = (value: string, min: number, max: number) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
export const validPrice = (value: string) => wholeNumber(value, 1, MAX_PRICE);
export const validStock = (value: string) => wholeNumber(value, 0, MAX_STOCK);
export const validText = (value: string, max: number) => value.trim().length > 0 && value.trim().length <= max;
export interface VariantDraft { sellerSku: string; name: string; price: string; attributeName: string; stock: Record<string, string> }
export const emptyVariant = (): VariantDraft => ({ sellerSku: '', name: '', price: '', attributeName: '', stock: {} });
export function variantError(v: VariantDraft): string | undefined {
  if (!validText(v.sellerSku, 100)) return 'Seller SKU must contain 1–100 characters.';
  if (!validText(v.name, 200)) return 'Variant name must contain 1–200 characters.';
  if (v.attributeName && !validText(v.attributeName, 100)) return 'Attribute name must contain 1–100 characters.';
  if (!validPrice(v.price)) return 'Price must be a whole VND amount from 1 to 2,000,000,000.';
  if (Object.values(v.stock).some((n) => !validStock(n))) return 'Stock must be a whole number from 0 to 99,999.';
}
export const variantBody = (v: VariantDraft) => ({ sellerSku: v.sellerSku.trim(), name: v.name.trim(), priceVnd: Number(v.price), ...(v.attributeName.trim() ? { attributeName: v.attributeName.trim() } : {}), ...(Object.keys(v.stock).length ? { stock: Object.fromEntries(Object.entries(v.stock).map(([k, n]) => [k, Number(n)])) } : {}) });
