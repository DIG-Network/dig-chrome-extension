import { describe, it, expect } from 'vitest';
import { activityRows } from './activityRows';
import { DIG_ASSET_ID } from '@/lib/links';
import { parseCatRegistry } from '@/features/wallet/catMetadata';
import type { ActivityEvent } from '@/offscreen/activity';

const ev = (o: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'x',
  kind: 'received',
  asset: 'XCH',
  amount: '0',
  counterparty: null,
  height: 1,
  timestamp: 100,
  coinId: 'a'.repeat(64),
  ...o,
});

describe('activityRows', () => {
  it('formats XCH amounts with 12 decimals + a SpaceScan link', () => {
    const [row] = activityRows([ev({ kind: 'received', asset: 'XCH', amount: '2510000000000' })]);
    expect(row.ticker).toBe('XCH');
    expect(row.amountLabel).toBe('2.51');
    expect(row.spaceScanUrl).toMatch(/a{64}/);
  });

  it('resolves $DIG (3 decimals) by asset id, with canonical branding even absent a registry', () => {
    const [row] = activityRows([ev({ asset: DIG_ASSET_ID, amount: '1500' })]);
    expect(row.ticker).toBe('$DIG');
    expect(row.amountLabel).toBe('1.5');
  });

  it('falls back to the generic CAT ticker + CAT decimals for an unknown token (no registry)', () => {
    const tail = 'b'.repeat(64);
    const [row] = activityRows([ev({ asset: tail, amount: '1000' })]);
    expect(row.ticker).toBe('CAT');
    expect(row.amountLabel).toBe('1'); // 3 decimals
  });

  it('#151 resolves a held CAT to its REAL ticker + decimals from the dexie registry', () => {
    const tail = 'c'.repeat(64);
    const registry = parseCatRegistry({
      tokens: [{ id: tail, name: 'Gamma Coin', code: 'GMA', denom: 1000, icon: `https://icons.dexie.space/${tail}.webp` }],
    });
    const [row] = activityRows([ev({ asset: tail, amount: '2500' })], registry);
    expect(row.ticker).toBe('GMA'); // NOT the generic 'CAT' fallback (#151)
    expect(row.amountLabel).toBe('2.5');
  });

  it('#151 a CAT absent from a loaded registry still degrades to the generic ticker (never blank/broken)', () => {
    const tail = 'd'.repeat(64);
    const registry = parseCatRegistry({ tokens: [{ id: 'e'.repeat(64), code: 'OTHER' }] });
    const [row] = activityRows([ev({ asset: tail, amount: '1000' })], registry);
    expect(row.ticker).toBe('CAT');
  });

  it('shortens the counterparty for sent rows', () => {
    const [row] = activityRows([ev({ kind: 'sent', counterparty: 'xch1qqqqexampleaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' })]);
    expect(row.kind).toBe('sent');
    expect(row.counterparty).toContain('…');
  });
});
