import { describe, it, expect } from 'vitest';
import { custodyAssetBalances } from './balances';
import { DIG_ASSET_ID } from '#shared/links.mjs';

describe('custodyAssetBalances', () => {
  it('maps XCH + $DIG from a scan onto the shared asset rows', () => {
    const rows = custodyAssetBalances({ xch: 2_510_000_000_000, cats: { [DIG_ASSET_ID]: 1000 } }, []);
    const xch = rows.find((r) => r.descriptor.key === 'xch');
    const dig = rows.find((r) => r.descriptor.key === 'dig');
    expect(xch?.balance).toBe(2_510_000_000_000);
    expect(dig?.balance).toBe(1000);
    expect(xch?.label).toBeTruthy();
  });

  it('renders null (not 0) for assets absent from the scan', () => {
    const rows = custodyAssetBalances({ xch: 0, cats: {} }, []);
    const dig = rows.find((r) => r.descriptor.key === 'dig');
    expect(dig?.balance).toBeNull();
  });

  it('matches CAT ids case-insensitively and ignoring 0x', () => {
    const rows = custodyAssetBalances({ xch: 0, cats: { [`0x${DIG_ASSET_ID.toUpperCase()}`]: 42 } }, []);
    const dig = rows.find((r) => r.descriptor.key === 'dig');
    expect(dig?.balance).toBe(42);
  });

  it('includes watched CATs from the stored list', () => {
    const tail = 'b'.repeat(64);
    const rows = custodyAssetBalances({ xch: 0, cats: { [tail]: 7 } }, [{ assetId: tail, name: 'TestCat' }]);
    const cat = rows.find((r) => r.descriptor.assetId?.toLowerCase() === tail);
    expect(cat?.balance).toBe(7);
  });

  it('handles an undefined scan (all null)', () => {
    const rows = custodyAssetBalances(undefined, []);
    expect(rows.every((r) => r.balance === null)).toBe(true);
  });
});
