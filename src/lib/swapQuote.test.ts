import { describe, it, expect } from 'vitest';
import { bestSwapQuote, dexieCodeOf } from './swapQuote';
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
