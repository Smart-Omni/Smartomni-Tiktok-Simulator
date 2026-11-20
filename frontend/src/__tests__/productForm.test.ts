import { describe, expect, it } from 'vitest';
import { attributesPayload, categoryPath, imageFileProblem, leafOptions, listingBody, move, reconcileAttributes, validateProductForm, type ProductFormState } from '@/lib/productForm';
import type { CategoryAttribute, CategoryNode } from '@/lib/types';

const tree: CategoryNode[] = [
  { id: '1', name: 'Fashion', isLeaf: false, children: [{ id: '2', name: 'Men tops', isLeaf: true, children: [] }, { id: '3', name: 'Women', isLeaf: false, children: [{ id: '4', name: 'Dresses', isLeaf: true, children: [] }] }] },
  { id: '5', name: 'Home', isLeaf: true, children: [] },
];

const origin: CategoryAttribute = { id: 'a1', name: 'Country of origin', isRequired: true, isMultipleSelection: false, isCustomizable: true, values: [{ id: 'v1', name: 'Vietnam' }] };
const material: CategoryAttribute = { id: 'a2', name: 'Material', isRequired: false, isMultipleSelection: true, isCustomizable: false, values: [{ id: 'm1', name: 'Cotton' }, { id: 'm2', name: 'Linen' }] };

const base: ProductFormState = { title: 'Shirt', description: '', imageUris: ['sim-media/x'], pendingImages: 0, categoryId: '2', brandId: '', attributes: { a1: ['Vietnam'] }, weightKg: '', length: '', width: '', height: '' };

describe('product form helpers', () => {
  it('lists leaves with their path and finds the path of a category', () => {
    expect(leafOptions(tree).map((l) => l.path)).toEqual(['Fashion > Men tops', 'Fashion > Women > Dresses', 'Home']);
    expect(categoryPath(tree, '4').map((n) => n.id)).toEqual(['1', '3', '4']);
    expect(categoryPath(tree, 'nope')).toEqual([]);
  });

  it('drops attribute values that do not fit the new category', () => {
    const kept = reconcileAttributes({ a1: ['Japan'], a2: ['Cotton', 'Silk'], gone: ['x'] }, [origin, material]);
    expect(kept).toEqual({ a1: ['Japan'], a2: ['Cotton'] });
    expect(reconcileAttributes({ a1: ['Japan'] }, [material])).toEqual({});
  });

  it('sends the value id for listed values and only the name for custom ones', () => {
    expect(attributesPayload({ a1: ['Vietnam'], a2: ['Linen'] }, [origin, material])).toEqual([
      { id: 'a1', values: [{ id: 'v1', name: 'Vietnam' }] },
      { id: 'a2', values: [{ id: 'm2', name: 'Linen' }] },
    ]);
    expect(attributesPayload({ a1: ['Laos'] }, [origin])).toEqual([{ id: 'a1', values: [{ name: 'Laos' }] }]);
  });

  it('validates the required fields, required attributes and dimensions', () => {
    expect(validateProductForm(base, true, [origin, material], { packageDimensionsRequired: false, sizeChartSupported: false, codSupported: true })).toEqual({});
    const e = validateProductForm({ ...base, title: ' ', imageUris: [], attributes: {} }, true, [origin], { packageDimensionsRequired: true, sizeChartSupported: false, codSupported: true });
    expect(Object.keys(e).sort()).toEqual(['attr:a1', 'dimensions', 'images', 'title']);
    expect(e['attr:a1']).toBe('Country of origin is required');
    expect(validateProductForm({ ...base, categoryId: '1' }, false, [], undefined).category).toMatch(/last level/);
    expect(validateProductForm({ ...base, pendingImages: 1 }, true, [], undefined).images).toMatch(/uploading/);
    expect(validateProductForm({ ...base, length: '10' }, true, [], undefined).dimensions).toMatch(/all be positive/);
    expect(validateProductForm({ ...base, weightKg: '-1' }, true, [], undefined).weight).toBeDefined();
  });

  it('builds the listing body', () => {
    expect(listingBody({ ...base, brandId: 'b1', weightKg: '0.5', length: '10', width: '20', height: '5' }, [origin])).toEqual({
      categoryId: '2',
      brandId: 'b1',
      images: ['sim-media/x'],
      productAttributes: [{ id: 'a1', values: [{ id: 'v1', name: 'Vietnam' }] }],
      packageWeight: { value: 0.5, unit: 'KILOGRAM' },
      packageDimensions: { length: 10, width: 20, height: 5, unit: 'CENTIMETER' },
    });
  });

  it('pre-checks picked files and reorders images', () => {
    expect(imageFileProblem(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/JPEG, PNG or WebP/);
    expect(imageFileProblem(new File(['x'], 'a.png', { type: 'image/png' }))).toBeUndefined();
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
