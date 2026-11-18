import type { InventoryLevel, Product, Sku, Warehouse } from '@prisma/client';

export type ProductWithSkus = Product & { skus: (Sku & { inventory: (InventoryLevel & { warehouse: Warehouse })[] })[] };

const toSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/** Money is a string in the OAS (`sale_price`, `amount`); VND has no minor units, so the stored integer is the amount. */
const money = (vnd: number): string => String(vnd);

/** Product audit status derived from the product status using only the OAS value list (NONE | AUDITING | FAILED | PRE_APPROVED | APPROVED). */
export function auditStatus(productStatus: string): string {
  switch (productStatus) {
    case 'ACTIVATE':
      return 'APPROVED';
    case 'PENDING':
      return 'AUDITING';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'NONE';
  }
}

function skuItem(s: ProductWithSkus['skus'][number]) {
  return {
    id: s.externalId,
    seller_sku: s.sellerSku,
    price: { currency: 'VND', sale_price: money(s.priceVnd) },
    inventory: s.inventory.map((i) => ({ warehouse_id: i.warehouse.externalId, quantity: i.quantity })),
    status_info: { status: s.status },
  };
}

/** Item of Search Products `data.products[]` (fields limited to what the simulator actually stores). */
export function productSummary(p: ProductWithSkus) {
  return {
    id: p.externalId,
    title: p.title,
    status: p.status,
    audit: { status: auditStatus(p.status) },
    has_draft: false,
    is_not_for_sale: p.isNotForSale,
    create_time: toSeconds(p.createdAt),
    update_time: toSeconds(p.updatedAt),
    skus: p.skus.map(skuItem),
  };
}

/** Get Product `data` (a superset of the search item: description, images and sales attributes). */
export function productDetail(p: ProductWithSkus, publicBaseUrl: string) {
  const imageUrl = `${publicBaseUrl.replace(/\/$/, '')}/demo/media/products/${p.id}.svg`;
  return {
    id: p.externalId,
    title: p.title,
    description: p.description,
    status: p.status,
    audit: { status: auditStatus(p.status) },
    has_draft: false,
    is_not_for_sale: p.isNotForSale,
    create_time: toSeconds(p.createdAt),
    update_time: toSeconds(p.updatedAt),
    main_images: Array.isArray(p.mainImages) && p.mainImages.length > 0 ? p.mainImages : [{ uri: `sim/product/${p.id}`, urls: [imageUrl], thumb_urls: [imageUrl], width: 600, height: 600 }],
    ...(p.packageWeight ? { package_weight: p.packageWeight } : {}),
    ...(p.packageDimensions ? { package_dimensions: p.packageDimensions } : {}),
    product_attributes: p.productAttributes,
    is_cod_allowed: p.isCodAllowed,
    ...(p.externalProductId ? { external_product_id: p.externalProductId } : {}),
    skus: p.skus.map((s) => ({
      ...skuItem(s),
      sales_attributes: [{ id: `attr-${p.externalId}`, name: s.attributeName, value_id: `val-${s.externalId}`, value_name: s.name }],
    })),
  };
}

/** Item of Get Warehouse List `data.warehouses[]`. `sub_type` DOMESTIC_WAREHOUSE / `type` SALES_WAREHOUSE are OAS values. */
export function warehouseItem(w: Warehouse, region: string) {
  return {
    id: w.externalId,
    name: w.name,
    effect_status: w.effectStatus,
    is_default: w.isDefault,
    type: 'SALES_WAREHOUSE',
    sub_type: 'DOMESTIC_WAREHOUSE',
    address: { city: w.city, region, region_code: region, full_address: `${w.name}, ${w.city}` },
  };
}
