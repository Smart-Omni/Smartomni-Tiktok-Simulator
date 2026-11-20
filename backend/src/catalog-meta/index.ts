import type { Prisma } from '@prisma/client';
import seededCatalog from './simulator-catalog.json';

/**
 * Category, attribute and brand data plus the listing rules, shared by the TikTok router (Get Categories, Get Attributes,
 * Get Category Rules, Get Brands, Create/Edit Product, Listing Check) and the /demo Seller Center catalog.
 * Plain data and pure functions: no Nest providers and no router-specific error types; each caller throws its own error.
 */

export interface CategoryMeta {
  id: string;
  parent_id: string;
  local_name: string;
  is_leaf: boolean;
  permission_statuses: string[];
}

export interface AttributeValueMeta {
  id: string;
  name: string;
}

/** Attribute field names follow the OAS spelling, including `is_requried`. */
export interface AttributeMeta {
  id: string;
  name: string;
  type: string;
  is_requried: boolean;
  is_multiple_selection: boolean;
  is_customizable: boolean;
  values: AttributeValueMeta[];
  requirement_conditions: unknown[];
}

export interface BrandMeta {
  id: string;
  name: string;
  authorized_status: string;
  is_t1_brand: boolean;
}

export const CATEGORIES_DATA: CategoryMeta[] = [
  { id: '100001', parent_id: '0', local_name: 'Thời trang & Phụ kiện', is_leaf: false, permission_statuses: ['AVAILABLE'] },
  { id: '100002', parent_id: '100001', local_name: 'Áo Nam', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '100003', parent_id: '100001', local_name: 'Quần Nam', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '100004', parent_id: '100001', local_name: 'Áo Nữ', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '200001', parent_id: '0', local_name: 'Điện tử & Phụ kiện', is_leaf: false, permission_statuses: ['AVAILABLE'] },
  { id: '200002', parent_id: '200001', local_name: 'Phụ kiện điện thoại', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '300001', parent_id: '0', local_name: 'Sức khỏe & Sắc đẹp', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '400001', parent_id: '0', local_name: 'Nhà cửa & Đời sống', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '500001', parent_id: '0', local_name: 'Hàng hạn chế (demo)', is_leaf: true, permission_statuses: ['INVITE_ONLY'] },
  ...seededCatalog.categories,
];

export const ATTRIBUTES_DATA: AttributeMeta[] = [
  { id: 'attr_brand', name: 'Thương hiệu', type: 'PRODUCT_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: false, values: [{ id: 'brand_001', name: 'No Brand' }], requirement_conditions: [] },
  { id: 'attr_color', name: 'Màu sắc', type: 'SALES_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [{ id: 'color_black', name: 'Đen' }, { id: 'color_white', name: 'Trắng' }], requirement_conditions: [] },
  { id: 'attr_size', name: 'Kích cỡ', type: 'SALES_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [{ id: 'size_s', name: 'S' }, { id: 'size_m', name: 'M' }, { id: 'size_l', name: 'L' }], requirement_conditions: [] },
  { id: 'attr_material', name: 'Chất liệu', type: 'PRODUCT_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [], requirement_conditions: [] },
];

const SEEDED_ATTRIBUTES = seededCatalog.attributesByCategory as Record<string, AttributeMeta[]>;

/** `UNAUTHORIEZD` is the OAS spelling of the unauthorized value. */
export const BRANDS_DATA: BrandMeta[] = [
  { id: 'brand_001', name: 'No Brand', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_002', name: 'OEM', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_003', name: 'SmartOmni', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_004', name: 'Apple', authorized_status: 'UNAUTHORIEZD', is_t1_brand: true },
  { id: 'brand_005', name: 'Samsung', authorized_status: 'UNAUTHORIEZD', is_t1_brand: true },
];

/** Demo requirements (DECISIONS DA-6): leaf 100002 requires attr_material, leaf 200002 requires package dimensions. */
export const REQUIRED_ATTRS: Record<string, string[]> = { '100002': ['attr_material'] };
export const DIMENSIONS_REQUIRED = new Set(['200002']);

export function findCategory(categoryId: string): CategoryMeta | undefined {
  return CATEGORIES_DATA.find((c) => c.id === categoryId);
}

export function isLeafCategory(categoryId: string): boolean {
  return findCategory(categoryId)?.is_leaf === true;
}

/** Root-first chain of a category and its ancestors (empty when the id is unknown). */
export function categoryChain(categoryId: string | null | undefined): CategoryMeta[] {
  const chain: CategoryMeta[] = [];
  for (let c = categoryId ? findCategory(categoryId) : undefined; c; c = findCategory(c.parent_id)) chain.unshift(c);
  return chain;
}

export function attributesFor(categoryId: string): AttributeMeta[] {
  if (SEEDED_ATTRIBUTES[categoryId]) return SEEDED_ATTRIBUTES[categoryId];
  const req = REQUIRED_ATTRS[categoryId] ?? [];
  return ATTRIBUTES_DATA.map((a) => ({ ...a, is_requried: req.includes(a.id) }));
}

export function rulesFor(categoryId: string) {
  return {
    cod: { is_supported: true },
    package_dimension: { is_required: DIMENSIONS_REQUIRED.has(categoryId) },
    size_chart: { is_required: false, is_supported: ['100002', '100003', '100004'].includes(categoryId) },
    product_certifications: [] as unknown[],
    epr: { is_required: false },
    fees: [] as unknown[],
    allowed_special_product_types: [] as unknown[],
  };
}

export interface ListingFields {
  categoryId?: string;
  brandId?: string;
  mainImages?: Prisma.InputJsonValue;
  packageWeight?: Prisma.InputJsonValue;
  packageDimensions?: Prisma.InputJsonValue;
  productAttributes?: Prisma.InputJsonValue;
  isCodAllowed?: boolean;
  externalProductId?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Shared by Create Product, Edit Product and Listing Check (snake_case OAS body). Fields are optional (the OAS declares
 * no required body fields), so they are only checked when sent. `existing` supplies stored values for Edit.
 */
export function checkListing(body: Record<string, unknown>, existing: ListingFields = {}): { reasons: string[]; fields: ListingFields } {
  const reasons: string[] = [];
  const fields: ListingFields = {};
  if (body.category_id !== undefined) {
    if (typeof body.category_id !== 'string') reasons.push('category_id must be a string');
    else if (!isLeafCategory(body.category_id)) reasons.push('category_id must be an existing leaf category');
    else fields.categoryId = body.category_id;
  }
  if (body.brand_id !== undefined) {
    if (typeof body.brand_id !== 'string' || !BRANDS_DATA.some((b) => b.id === body.brand_id)) reasons.push('brand_id does not exist');
    else fields.brandId = body.brand_id;
  }
  if (body.main_images !== undefined) {
    if (!Array.isArray(body.main_images) || body.main_images.length > 9 || body.main_images.some((i) => !isObj(i) || typeof i.uri !== 'string')) reasons.push('main_images must be an array of up to 9 objects with a uri');
    else fields.mainImages = body.main_images as Prisma.InputJsonValue;
  }
  if (body.package_weight !== undefined) {
    if (!isObj(body.package_weight) || Number.isNaN(Number(body.package_weight.value)) || Number(body.package_weight.value) <= 0) reasons.push('package_weight.value must be a positive number');
    else fields.packageWeight = body.package_weight as Prisma.InputJsonValue;
  }
  if (body.package_dimensions !== undefined) {
    const d = body.package_dimensions;
    if (!isObj(d) || ['length', 'width', 'height'].some((k) => Number.isNaN(Number(d[k])) || Number(d[k]) <= 0)) reasons.push('package_dimensions length, width and height must be positive numbers');
    else fields.packageDimensions = d as Prisma.InputJsonValue;
  }
  if (body.product_attributes !== undefined) {
    if (!Array.isArray(body.product_attributes) || body.product_attributes.some((a) => !isObj(a) || typeof a.id !== 'string')) reasons.push('product_attributes must be an array of objects with an id');
    else fields.productAttributes = body.product_attributes as Prisma.InputJsonValue;
  }
  if (body.is_cod_allowed !== undefined) {
    if (typeof body.is_cod_allowed !== 'boolean') reasons.push('is_cod_allowed must be a boolean');
    else fields.isCodAllowed = body.is_cod_allowed;
  }
  if (body.external_product_id !== undefined) {
    if (typeof body.external_product_id !== 'string' || body.external_product_id.length > 200) reasons.push('external_product_id must be a string up to 200 chars');
    else fields.externalProductId = body.external_product_id;
  }
  if (reasons.length === 0) {
    const eff = { ...existing, ...fields };
    if (eff.categoryId) {
      const sent = new Set(((eff.productAttributes as Array<{ id: string }> | undefined) ?? []).map((a) => a.id));
      for (const id of REQUIRED_ATTRS[eff.categoryId] ?? []) if (!sent.has(id)) reasons.push(`required attribute ${id} is missing from product_attributes`);
      if (DIMENSIONS_REQUIRED.has(eff.categoryId) && !eff.packageDimensions) reasons.push('package_dimensions is required for this category');
      if (eff.isCodAllowed && !rulesFor(eff.categoryId).cod.is_supported) reasons.push('COD is not supported in this category');
    }
  }
  return { reasons, fields };
}
