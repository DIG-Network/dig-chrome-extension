import { describe, it, expect } from 'vitest';
import { activityRows } from './activityRows';
import { DIG_ASSET_ID } from '@/lib/links';
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
    const [row] = activityRows([ev({ kind: 'received', asset: 'XCH', amount: '2510000000000' })], []);
    expect(row.ticker).toBe('XCH');
    expect(row.amountLabel).toBe('2.51');
    expect(row.spaceScanUrl).toMatch(/a{64}/);
  });

  it('resolves $DIG (3 decimals) by asset id', () => {
    const [row] = activityRows([ev({ asset: DIG_ASSET_ID, amount: '1500' })], []);
    expect(row.ticker).toBe('$DIG');
    expect(row.amountLabel).toBe('1.5');
  });

  it('falls back to a short id + CAT decimals for an unknown token', () => {
    const tail = 'b'.repeat(64);
    const [row] = activityRows([ev({ asset: tail, amount: '1000' })], []);
    expect(row.ticker).toMatch(/^CAT /);
    expect(row.amountLabel).toBe('1'); // 3 decimals
  });

  it('shortens the counterparty for sent rows', () => {
    const [row] = activityRows([ev({ kind: 'sent', counterparty: 'xch1qqqqexampleaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' })], []);
    expect(row.kind).toBe('sent');
    expect(row.counterparty).toContain('…');
  });
});
