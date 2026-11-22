import { describe, expect, it } from 'vitest';
import { emptyVariant, validPrice, validStock, variantBody, variantError } from '@/lib/catalogValidation';

describe('catalog API limits', () => {
  it('accepts inclusive money and stock boundaries and rejects invalid representations', () => {
    for (const value of ['1', '2000000000']) expect(validPrice(value)).toBe(true);
    for (const value of ['0', '2000000001', '-1', '1.5', '1e3', '', 'Infinity']) expect(validPrice(value)).toBe(false);
    for (const value of ['0', '99999']) expect(validStock(value)).toBe(true);
    for (const value of ['100000', '-1', '2.5', '', '1e3']) expect(validStock(value)).toBe(false);
  });
  it('checks trimmed metadata, optional attributes and each warehouse before building the request', () => {
    const draft = { ...emptyVariant(), sellerSku: '  SKU-1 ', name: ' Blue ', price: '2000000000', attributeName: ' Color ', stock: { wh1: '0', wh2: '99999' } };
    expect(variantError(draft)).toBeUndefined();
    expect(variantBody(draft)).toEqual({ sellerSku: 'SKU-1', name: 'Blue', priceVnd: 2000000000, attributeName: 'Color', stock: { wh1: 0, wh2: 99999 } });
    for (const invalid of [{ sellerSku: 'x'.repeat(101) }, { name: 'x'.repeat(201) }, { attributeName: 'x'.repeat(101) }, { stock: { wh1: '100000' } }]) expect(variantError({ ...draft, ...invalid })).toBeDefined();
  });
});
