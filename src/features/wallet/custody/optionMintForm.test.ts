import { describe, it, expect } from 'vitest';
import { validateOptionMintForm, EMPTY_OPTION_MINT_FORM, type OptionMintForm } from './optionMintForm';

const NOW = 1_700_000_000;

describe('optionMintForm — validateOptionMintForm', () => {
  const base: OptionMintForm = { ...EMPTY_OPTION_MINT_FORM, underlyingXch: '1', strikeXch: '0.5', expiresInDays: '30' };

  it('accepts a valid form with no fee', () => {
    const res = validateOptionMintForm(base, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params).toEqual({
        underlyingAmount: '1000000000000',
        strikeAmount: '500000000000',
        expirationSeconds: String(NOW + 30 * 86_400),
        fee: '0',
      });
    }
  });

  it('accepts a valid form with a fee', () => {
    const res = validateOptionMintForm({ ...base, fee: '0.000001' }, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.params.fee).toBe('1000000');
  });

  it('rejects a zero/negative/non-numeric underlying amount', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      const res = validateOptionMintForm({ ...base, underlyingXch: bad }, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.underlyingXch).toBe('options.error.underlying');
    }
  });

  it('rejects a zero/negative strike amount', () => {
    const res = validateOptionMintForm({ ...base, strikeXch: '0' }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.strikeXch).toBe('options.error.strike');
  });

  it('rejects a non-whole or non-positive expiration in days', () => {
    for (const bad of ['0', '-5', '2.5', 'abc']) {
      const res = validateOptionMintForm({ ...base, expiresInDays: bad }, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.expiresInDays).toBe('options.error.expires');
    }
  });

  it('rejects an invalid fee', () => {
    const res = validateOptionMintForm({ ...base, fee: '-1' }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.fee).toBe('options.error.fee');
  });
});
