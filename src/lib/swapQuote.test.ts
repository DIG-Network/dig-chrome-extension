import { describe, it, expect } from 'vitest';
import { bestSwapQuote, dexieCodeOf, validateSwapAmount } from './swapQuote';
import type { DexieOfferSummary } from '@/lib/dexie';

function offer(over: Partial<DexieOfferSummary> = {}): DexieOfferSummary {
  return {
    id: 'o1',
    offerStr: 'offer1qqq',
    status: 0,
    dateFound: '2026-01-01T00:00:00Z',
    offered: [{ id: 'xch', code: 'XCH', amount: 10 }],
    requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 1000 }],
    ...over,
  };
}

describe('swapQuote — bestSwapQuote', () => {
  it('returns null for an empty offer list', () => {
    expect(bestSwapQuote([], 'DBX', 'XCH')).toBeNull();
  });

  it('returns null when sellCode === buyCode', () => {
    expect(bestSwapQuote([offer()], 'XCH', 'XCH')).toBeNull();
  });

  it('quotes the matching offer (DBX -> XCH)', () => {
    const q = bestSwapQuote([offer()], 'DBX', 'XCH');
    expect(q).toEqual({ dexieId: 'o1', offerStr: 'offer1qqq', sellCode: 'DBX', sellAmount: 1000, buyCode: 'XCH', buyAmount: 10, rate: 0.01 });
  });

  it('matches by raw asset id too (not just the ticker code)', () => {
    const q = bestSwapQuote([offer()], 'aa'.repeat(32), 'XCH');
    expect(q?.sellAmount).toBe(1000);
  });

  it('picks the BEST rate among multiple candidates', () => {
    const cheap = offer({ id: 'cheap', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 2000 }] });
    const rich = offer({ id: 'rich', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 500 }] });
    const q = bestSwapQuote([cheap, rich], 'DBX', 'XCH');
    expect(q?.dexieId).toBe('rich'); // 10 XCH for only 500 DBX is the better rate
  });

  it('ignores non-open offers (status !== 0)', () => {
    const closed = offer({ status: 4 });
    expect(bestSwapQuote([closed], 'DBX', 'XCH')).toBeNull();
  });

  it('ignores offers with a zero/negative leg amount', () => {
    const bad = offer({ requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 0 }] });
    expect(bestSwapQuote([bad], 'DBX', 'XCH')).toBeNull();
  });

  it('ignores offers that do not carry both legs', () => {
    const noBuy = offer({ offered: [{ id: 'bb'.repeat(32), code: 'OTHER', amount: 5 }] });
    expect(bestSwapQuote([noBuy], 'DBX', 'XCH')).toBeNull();
  });
});

describe('swapQuote — dexieCodeOf', () => {
  it('maps XCH to the literal code', () => {
    expect(dexieCodeOf({ kind: 'xch' })).toBe('XCH');
  });
  it('maps a CAT to its asset id', () => {
    expect(dexieCodeOf({ kind: 'cat', assetId: 'aa'.repeat(32) })).toBe('aa'.repeat(32));
  });
});

describe('swapQuote — bestSwapQuote (#484, desired sell amount)', () => {
  it('with no desired amount given, behaves exactly like the unconstrained best-rate pick (back-compat)', () => {
    const cheap = offer({ id: 'cheap', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 2000 }] });
    const rich = offer({ id: 'rich', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 500 }] });
    expect(bestSwapQuote([cheap, rich], 'DBX', 'XCH')?.dexieId).toBe('rich');
  });

  it('excludes an offer whose required sell amount exceeds the desired ceiling, even if it is the best rate', () => {
    // "rich" needs 500 DBX (best rate) but the user only wants to sell up to 300; "cheap" needs 2000
    // DBX (worse rate) and also does not fit. Neither should be selected.
    const cheap = offer({ id: 'cheap', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 2000 }] });
    const rich = offer({ id: 'rich', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 500 }] });
    expect(bestSwapQuote([cheap, rich], 'DBX', 'XCH', 300)).toBeNull();
  });

  it('picks the best-rate offer AMONG those that fit the desired sell amount, not the global best rate', () => {
    // "rich" (500 DBX, best rate) does not fit a 300-DBX budget; "affordable" (250 DBX, worse rate)
    // does — the entered amount must steer selection toward the one the user can actually afford.
    const rich = offer({ id: 'rich', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 500 }] });
    const affordable = offer({ id: 'affordable', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 250 }], offered: [{ id: 'xch', code: 'XCH', amount: 2 }] });
    const q = bestSwapQuote([rich, affordable], 'DBX', 'XCH', 300);
    expect(q?.dexieId).toBe('affordable');
  });

  it('includes an offer whose required sell amount exactly equals the desired ceiling (inclusive bound)', () => {
    const exact = offer({ id: 'exact', requested: [{ id: 'aa'.repeat(32), code: 'DBX', amount: 300 }] });
    expect(bestSwapQuote([exact], 'DBX', 'XCH', 300)?.dexieId).toBe('exact');
  });

  it('treats a zero/negative desired amount as "no ceiling" (falls back to unconstrained best-rate)', () => {
    const q = bestSwapQuote([offer()], 'DBX', 'XCH', 0);
    expect(q?.sellAmount).toBe(1000);
    expect(bestSwapQuote([offer()], 'DBX', 'XCH', -5)?.sellAmount).toBe(1000);
  });
});

describe('swapQuote — validateSwapAmount (#484)', () => {
  const XCH_DECIMALS = 12;
  const CAT_DECIMALS = 3;

  it('rejects a blank amount', () => {
    expect(validateSwapAmount('', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: false, error: 'swap.amount.error.required' });
    expect(validateSwapAmount('   ', XCH_DECIMALS, 5_000_000_000_000).ok).toBe(false);
  });

  it('rejects zero', () => {
    expect(validateSwapAmount('0', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: false, error: 'swap.amount.error.invalid' });
  });

  it('rejects a negative amount', () => {
    expect(validateSwapAmount('-1', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: false, error: 'swap.amount.error.invalid' });
  });

  it('rejects non-numeric garbage', () => {
    expect(validateSwapAmount('abc', XCH_DECIMALS, 5_000_000_000_000).ok).toBe(false);
  });

  it('rejects more fractional digits than the asset supports (precision)', () => {
    // CAT: 3 decimals — a 4th fractional digit can't be represented in base units.
    expect(validateSwapAmount('1.1234', CAT_DECIMALS, 100_000)).toEqual({ ok: false, error: 'swap.amount.error.precision' });
  });

  it('accepts an amount using exactly the asset decimals worth of fractional digits', () => {
    expect(validateSwapAmount('1.123', CAT_DECIMALS, 100_000)).toEqual({ ok: true });
  });

  it('rejects an amount over the available balance', () => {
    // 6 XCH requested, only 5 XCH (5_000_000_000_000 mojos) spendable.
    expect(validateSwapAmount('6', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: false, error: 'swap.amount.error.insufficientBalance' });
  });

  it('accepts an amount exactly at the spendable balance (inclusive bound)', () => {
    expect(validateSwapAmount('5', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: true });
  });

  it('treats an unknown (null) balance as insufficient — fail-closed', () => {
    expect(validateSwapAmount('1', XCH_DECIMALS, null)).toEqual({ ok: false, error: 'swap.amount.error.insufficientBalance' });
  });

  it('accepts an ordinary valid amount well within balance', () => {
    expect(validateSwapAmount('2.5', XCH_DECIMALS, 5_000_000_000_000)).toEqual({ ok: true });
  });
});
