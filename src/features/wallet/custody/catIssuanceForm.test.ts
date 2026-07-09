import { describe, it, expect } from 'vitest';
import { validateCatIssuanceForm, supplyToBaseUnits, EMPTY_CAT_ISSUANCE_FORM, type CatIssuanceForm } from './catIssuanceForm';

describe('catIssuanceForm — supplyToBaseUnits', () => {
  it('converts a whole-token supply to base units at the 3-decimal CAT convention', () => {
    expect(supplyToBaseUnits('1000000')).toBe(1_000_000_000);
    expect(supplyToBaseUnits('1')).toBe(1000);
  });

  it('rejects zero, negative, or non-numeric supply', () => {
    expect(supplyToBaseUnits('0')).toBeNull();
    expect(supplyToBaseUnits('-5')).toBeNull();
    expect(supplyToBaseUnits('abc')).toBeNull();
    expect(supplyToBaseUnits('')).toBeNull();
  });
});

describe('catIssuanceForm — validateCatIssuanceForm', () => {
  const base: CatIssuanceForm = { ...EMPTY_CAT_ISSUANCE_FORM, supply: '1000' };

  it('accepts a valid single-issuance form with no fee', () => {
    const res = validateCatIssuanceForm(base);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params).toEqual({ amount: '1000000', mode: 'single', fee: '0' });
    }
  });

  it('accepts a valid multi-issuance form with a fee', () => {
    const res = validateCatIssuanceForm({ ...base, mode: 'multi', fee: '0.000001' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params.mode).toBe('multi');
      expect(res.params.fee).toBe('1000000');
    }
  });

  it('rejects an empty or non-positive supply', () => {
    const res = validateCatIssuanceForm({ ...base, supply: '0' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.supply).toBe('issue.error.supply');
  });

  it('rejects an invalid fee', () => {
    const res = validateCatIssuanceForm({ ...base, fee: '-1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.fee).toBe('issue.error.fee');
  });
});
