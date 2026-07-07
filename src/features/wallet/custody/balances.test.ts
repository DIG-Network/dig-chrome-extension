import { describe, it, expect } from 'vitest';
import { custodyAssetBalances } from './balances';
import { DIG_ASSET_ID } from '@/lib/links';
import { parseCatRegistry } from '@/features/wallet/catMetadata';
import chiaLeafUrl from '@/assets/chia-leaf.png';

describe('custodyAssetBalances', () => {
  it('maps XCH + $DIG from a scan onto the shared asset rows', () => {
    const rows = custodyAssetBalances({ xch: 2_510_000_000_000, cats: { [DIG_ASSET_ID]: 1000 } }, []);
    const xch = rows.find((r) => r.descriptor.key === 'xch');
    const dig = rows.find((r) => r.descriptor.key === 'dig');
    expect(xch?.balance).toBe(2_510_000_000_000);
    expect(dig?.balance).toBe(1000);
    expect(xch?.label).toBeTruthy();
  });

  it('#161 XCH shows the bundled Chia leaf icon, never a monogram fallback', () => {
    const rows = custodyAssetBalances({ xch: 1_000_000_000_000, cats: {} }, []);
    const xch = rows.find((r) => r.descriptor.key === 'xch');
    expect(xch?.descriptor.iconUrl).toBe(chiaLeafUrl);
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

  it('auto-discovers a held CAT (in the scan, not watched) as a row (#87)', () => {
    const tail = 'a'.repeat(64);
    const rows = custodyAssetBalances({ xch: 0, cats: { [tail]: 4200 } }, []);
    const cat = rows.find((r) => r.descriptor.assetId?.toLowerCase() === tail);
    expect(cat?.balance).toBe(4200); // surfaced with NO watch list
    expect(cat?.descriptor.ticker).toBe('CAT'); // no registry → generic ticker
    expect(cat?.descriptor.name).toBe('aaaaaa…aaaa'); // short-form fallback
    expect(cat?.descriptor.iconUrl).toBeNull();
  });

  it('enriches a discovered CAT with registry name/ticker/icon/decimals', () => {
    const tail = 'c'.repeat(64);
    const registry = parseCatRegistry({ tokens: [{ id: tail, name: 'Gamma Coin', code: 'GMA', denom: 1000, icon: `https://icons.dexie.space/${tail}.webp` }] });
    const rows = custodyAssetBalances({ xch: 0, cats: { [tail]: 1500 } }, [], { registry });
    const cat = rows.find((r) => r.descriptor.assetId?.toLowerCase() === tail)!;
    expect(cat.descriptor.name).toBe('Gamma Coin');
    expect(cat.descriptor.ticker).toBe('GMA');
    expect(cat.descriptor.iconUrl).toBe(`https://icons.dexie.space/${tail}.webp`);
    expect(cat.balance).toBe(1500);
  });

  it('hides a CAT the user hid, even if held', () => {
    const tail = 'd'.repeat(64);
    const rows = custodyAssetBalances({ xch: 0, cats: { [tail]: 9 } }, [], { hidden: [tail] });
    expect(rows.find((r) => r.descriptor.assetId?.toLowerCase() === tail)).toBeUndefined();
  });

  it('keeps the built-in $DIG branding but takes its icon from the registry', () => {
    const registry = parseCatRegistry({ tokens: [{ id: DIG_ASSET_ID, name: 'DIG Network', code: 'DIG', icon: `https://icons.dexie.space/${DIG_ASSET_ID}.webp` }] });
    const rows = custodyAssetBalances({ xch: 0, cats: { [DIG_ASSET_ID]: 1000 } }, [], { registry });
    const digRows = rows.filter((r) => r.descriptor.assetId?.toLowerCase() === DIG_ASSET_ID.toLowerCase());
    expect(digRows).toHaveLength(1); // not duplicated as a discovered CAT
    expect(digRows[0].descriptor.key).toBe('dig');
    expect(digRows[0].descriptor.ticker).toBe('$DIG'); // canonical branding wins over registry "DIG"
    expect(digRows[0].descriptor.iconUrl).toBe(`https://icons.dexie.space/${DIG_ASSET_ID}.webp`);
  });

  it('prefers a user-given watched name over the registry name', () => {
    const tail = 'e'.repeat(64);
    const registry = parseCatRegistry({ tokens: [{ id: tail, name: 'Registry Name', code: 'REG', denom: 1000 }] });
    const rows = custodyAssetBalances({ xch: 0, cats: { [tail]: 1 } }, [{ assetId: tail, name: 'My Label' }], { registry });
    const cat = rows.find((r) => r.descriptor.assetId?.toLowerCase() === tail)!;
    expect(cat.descriptor.name).toBe('My Label');
    expect(cat.descriptor.ticker).toBe('REG'); // ticker still from the registry
  });
});
