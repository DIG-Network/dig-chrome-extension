import { describe, it, expect } from 'vitest';
import { xchMojosToUsd, catBaseUnitsToUsd } from '@/features/wallet/custody/approvalFiat';
import type { PriceMap } from '@/features/wallet/priceTypes';

/**
 * Pure USD-conversion math for the dApp approval window's fiat equivalents (#77 P2-1). No DOM /
 * chrome.* / intl — the renderer only formats + displays the number this module computes.
 */

const CAT = 'a406d3961da0da3daa196ca9f2f81bafda9d7d3e3d8b25de5b3616fa9c9f2f81';
const PRICES: PriceMap = {
  xch: { usd: 20, change24h: null },
  [CAT]: { usd: 2, change24h: null },
};

describe('xchMojosToUsd', () => {
  it('converts a mojo amount (12 decimals) to USD using the xch price', () => {
    // 1 XCH = 1e12 mojos; 0.5 XCH * $20 = $10
    expect(xchMojosToUsd('500000000000', PRICES)).toBe(10);
  });

  it('returns null when the XCH price is not yet known', () => {
    expect(xchMojosToUsd('500000000000', {})).toBeNull();
  });

  it('returns null for a non-numeric amount', () => {
    expect(xchMojosToUsd('not-a-number', PRICES)).toBeNull();
  });
});

describe('catBaseUnitsToUsd', () => {
  it('converts a CAT base-unit amount to USD using the CAT price + its decimals', () => {
    // 3 decimals (CAT_DECIMALS): 5000 base units = 5 whole tokens * $2 = $10
    expect(catBaseUnitsToUsd(CAT, '5000', 3, PRICES)).toBe(10);
  });

  it('returns null when that CAT has no known price', () => {
    expect(catBaseUnitsToUsd('bb'.repeat(32), '5000', 3, PRICES)).toBeNull();
  });

  it('returns null for a non-numeric amount', () => {
    expect(catBaseUnitsToUsd(CAT, 'nope', 3, PRICES)).toBeNull();
  });

  it('normalizes a 0x-prefixed / mixed-case asset id the same as the lowercase form', () => {
    expect(catBaseUnitsToUsd(`0x${CAT.toUpperCase()}`, '5000', 3, PRICES)).toBe(10);
  });
});
