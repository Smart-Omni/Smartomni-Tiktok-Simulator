import type { CatalogProduct, CategoryAttribute, CategoryNode, CategoryRules, ProductAttribute, ProductListingBody } from './types';

/** Product form rules (Seller Center product page). The backend re-checks every one of them. */
export const MAX_IMAGES = 9;
export const MAX_IMAGE_MB = 5;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface LeafOption {
  id: string;
  name: string;
  /** "Parent > Child > Leaf" */
  path: string;
}

/** Every leaf category with its full path, for the search box. */
export function leafOptions(tree: CategoryNode[]): LeafOption[] {
  const out: LeafOption[] = [];
  const walk = (nodes: CategoryNode[], trail: string[]) => {
    for (const n of nodes) {
      const names = [...trail, n.name];
      if (n.isLeaf) out.push({ id: n.id, name: n.name, path: names.join(' > ') });
      walk(n.children, names);
    }
  };
  walk(tree, []);
  return out;
}

/** Root-first chain of nodes down to `id` (empty when not found). */
export function categoryPath(tree: CategoryNode[], id: string | null | undefined): CategoryNode[] {
  if (!id) return [];
  for (const n of tree) {
    if (n.id === id) return [n];
    const below = categoryPath(n.children, id);
    if (below.length) return [n, ...below];
  }
  return [];
}

/** Attribute values as typed in the form: value names per attribute id. */
export type AttributeValues = Record<string, string[]>;

/** Keeps only attributes of the new category, and only listed values for attributes that do not allow custom ones. */
export function reconcileAttributes(values: AttributeValues, attributes: CategoryAttribute[]): AttributeValues {
  const out: AttributeValues = {};
  for (const a of attributes) {
    const current = values[a.id];
    if (!current) continue;
    const kept = a.isCustomizable ? current : current.filter((n) => a.values.some((v) => v.name === n));
    if (kept.length) out[a.id] = a.isMultipleSelection ? kept : kept.slice(0, 1);
  }
  return out;
}

/** Splits a free-text multi value ("Cotton, Linen") into names. */
export const splitValues = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function attributesPayload(values: AttributeValues, attributes: CategoryAttribute[]): ProductAttribute[] {
  return attributes
    .filter((a) => values[a.id]?.length)
    .map((a) => ({
      id: a.id,
      values: values[a.id].map((name) => {
        const known = a.values.find((v) => v.name === name);
        return known ? { id: known.id, name: known.name } : { name };
      }),
    }));
}

/** Form values from a stored product (edit page). */
export function attributeValuesOf(p: Pick<CatalogProduct, 'productAttributes'>): AttributeValues {
  const out: AttributeValues = {};
  for (const a of p.productAttributes ?? []) {
    const names = a.values.map((v) => v.name).filter((n): n is string => Boolean(n));
    if (names.length) out[a.id] = names;
  }
  return out;
}

export interface ProductFormState {
  title: string;
  description: string;
  imageUris: string[];
  /** Images still uploading or that failed: the form cannot be saved while any is pending. */
  pendingImages: number;
  categoryId: string;
  brandId: string;
  attributes: AttributeValues;
  weightKg: string;
  length: string;
  width: string;
  height: string;
}

export type FormErrors = Partial<Record<'title' | 'images' | 'category' | 'weight' | 'dimensions' | `attr:${string}`, string>>;

const positive = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0;

export function validateProductForm(f: ProductFormState, leaf: boolean, attributes: CategoryAttribute[], rules: CategoryRules | undefined): FormErrors {
  const e: FormErrors = {};
  if (!f.title.trim()) e.title = 'Enter a product title';
  else if (f.title.trim().length > 500) e.title = 'The title can have at most 500 characters';
  if (f.pendingImages > 0) e.images = 'Wait for the images to finish uploading (or remove the failed ones)';
  else if (f.imageUris.length === 0) e.images = 'Add at least one image';
  else if (f.imageUris.length > MAX_IMAGES) e.images = `At most ${MAX_IMAGES} images`;
  if (!f.categoryId) e.category = 'Choose a category';
  else if (!leaf) e.category = 'Choose a category down to the last level';
  for (const a of attributes) if (a.isRequired && !f.attributes[a.id]?.length) e[`attr:${a.id}`] = `${a.name} is required`;
  if (f.weightKg.trim() !== '' && !positive(f.weightKg)) e.weight = 'Weight must be a positive number';
  const dims = [f.length, f.width, f.height];
  const anyDim = dims.some((d) => d.trim() !== '');
  if ((anyDim || rules?.packageDimensionsRequired) && !dims.every(positive)) {
    e.dimensions = rules?.packageDimensionsRequired ? 'This category requires the package length, width and height' : 'Length, width and height must all be positive numbers';
  }
  return e;
}

/** Listing fields sent to the create and edit endpoints. */
export function listingBody(f: ProductFormState, attributes: CategoryAttribute[]): ProductListingBody {
  const dims = [f.length, f.width, f.height];
  return {
    categoryId: f.categoryId,
    // null clears a stored value on edit
    brandId: f.brandId || null,
    images: f.imageUris,
    productAttributes: attributesPayload(f.attributes, attributes),
    packageWeight: positive(f.weightKg) ? { value: Number(f.weightKg), unit: 'KILOGRAM' } : null,
    packageDimensions: dims.every(positive) ? { length: Number(f.length), width: Number(f.width), height: Number(f.height), unit: 'CENTIMETER' } : null,
  };
}

/** Client-side pre-check of a picked file (the server checks the bytes again). */
export function imageFileProblem(file: File): string | undefined {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name}: only JPEG, PNG or WebP images`;
  if (file.size > MAX_IMAGE_MB * 1024 * 1024) return `${file.name}: larger than ${MAX_IMAGE_MB} MB`;
  return undefined;
}

/** Moves item `from` to index `to` (image reordering). */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
