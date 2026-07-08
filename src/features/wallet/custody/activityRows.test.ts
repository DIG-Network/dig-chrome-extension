import { describe, it, expect } from 'vitest';
import { activityRows } from './activityRows';
import { DIG_ASSET_ID } from '@/lib/links';
import { parseCatRegistry } from '@/features/wallet/catMetadata';
import type { LocalActivityEntry } from '@/lib/activity-log';

const ev = (o: Partial<LocalActivityEntry> = {}): LocalActivityEntry => ({
  id: 'x',
  kind: 'received',
  asset: 'XCH',
  amount: '0',
  counterparty: null,
  timestamp: 100,
  coinId: 'a'.repeat(64),
  status: 'confirmed',
  ...o,
});

describe('activityRows (#154 — local log entries, not on-chain events)', () => {
  it('formats XCH amounts with 12 decimals + a SpaceScan link when confirmed', () => {
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

  it('#154 renders the synthetic NFT/DID asset labels as whole-unit tickers, never through the CAT decimal math', () => {
    const [nftRow] = activityRows([ev({ kind: 'mint', asset: 'NFT', amount: '1' })]);
    expect(nftRow.ticker).toBe('NFT');
    expect(nftRow.amountLabel).toBe('1');
    const [didRow] = activityRows([ev({ kind: 'did', asset: 'DID', amount: '1' })]);
    expect(didRow.ticker).toBe('DID');
    expect(didRow.amountLabel).toBe('1');
  });

  it('#154 carries status through, and omits the SpaceScan link while still pending', () => {
    const [row] = activityRows([ev({ kind: 'sent', status: 'pending', coinId: 'f'.repeat(64) })]);
    expect(row.status).toBe('pending');
    expect(row.spaceScanUrl).toBeNull();
  });

  it('#154 a best-effort received entry (no specific coin id) never sets a SpaceScan link', () => {
    const [row] = activityRows([ev({ kind: 'received', coinId: null })]);
    expect(row.spaceScanUrl).toBeNull();
    expect(row.coinId).toBeNull();
  });

  // #113 — transaction detail view fields: fee/memo are additive + never fabricated; a full
  // (unshortened) counterparty address link and a CAT token-page link are precomputed for #114.
  it('#113 exposes a null feeLabel/memo when the entry carries neither (never fabricated)', () => {
    const [row] = activityRows([ev({ kind: 'sent', counterparty: 'xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz' })]);
    expect(row.feeLabel).toBeNull();
    expect(row.memo).toBeNull();
  });

  it('#113 formats a recorded fee in XCH, independent of the transferred asset\'s own decimals', () => {
    const [row] = activityRows([ev({ kind: 'sent', asset: DIG_ASSET_ID, amount: '1500', fee: '1000000000' })]);
    expect(row.feeLabel).toBe('0.001'); // 1_000_000_000 mojos = 0.001 XCH, NOT $DIG's 3-decimal math
  });

  it('#113 passes a recorded memo through verbatim', () => {
    const [row] = activityRows([ev({ kind: 'sent', memo: 'thanks!' })]);
    expect(row.memo).toBe('thanks!');
  });

  it('#114 builds a SpaceScan address link for the FULL (unshortened) counterparty address', () => {
    const full = 'xch1qqqqexampleaddressqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz';
    const [row] = activityRows([ev({ kind: 'sent', counterparty: full })]);
    expect(row.counterpartyUrl).toBe(`https://www.spacescan.io/address/${full}`);
    expect(row.counterparty).not.toBe(full); // display value stays shortened
  });

  it('#114 has no counterparty link when there is no counterparty', () => {
    const [row] = activityRows([ev({ kind: 'received', counterparty: null })]);
    expect(row.counterpartyUrl).toBeNull();
  });

  it('#114 builds a SpaceScan token link for a CAT-class asset', () => {
    const tail = 'c'.repeat(64);
    const [row] = activityRows([ev({ asset: tail })]);
    expect(row.tokenUrl).toBe(`https://www.spacescan.io/token/${tail}`);
  });

  it('#114 omits the token link for XCH and the synthetic NFT/DID labels', () => {
    const [xchRow] = activityRows([ev({ asset: 'XCH' })]);
    expect(xchRow.tokenUrl).toBeNull();
    const [nftRow] = activityRows([ev({ kind: 'mint', asset: 'NFT' })]);
    expect(nftRow.tokenUrl).toBeNull();
    const [didRow] = activityRows([ev({ kind: 'did', asset: 'DID' })]);
    expect(didRow.tokenUrl).toBeNull();
  });

  it('#114 builds a token link for $DIG too (it is a CAT under the hood)', () => {
    const [row] = activityRows([ev({ asset: DIG_ASSET_ID })]);
    expect(row.tokenUrl).toBe(`https://www.spacescan.io/token/${DIG_ASSET_ID}`);
  });
});
