import { describe, it, expect } from 'vitest';
import {
  DIG_BASE_UNITS_PER_DIG,
  TIP_MODES,
  TIP_TIMEFRAMES,
  isTipMode,
  baseUnitsToDigString,
  digStringToBaseUnits,
  isValidTipAmountDig,
  DEFAULT_AUTOTIP_POLICY,
  DEFAULT_TIPPING_CONFIG,
  normalizeAutoTipPolicy,
  normalizeTippingConfig,
  normalizeLedgerEntry,
  normalizeLedger,
  tipEntryMillis,
  timeframeCutoffMs,
  filterLedgerByTimeframe,
  summarizeLedger,
  tipConfigToForm,
  tipFormToConfig,
  isTipFormValid,
  isAmountField,
  type TipLedgerEntry,
} from '@/lib/tipping';

describe('tipping — $DIG base-unit conversions', () => {
  it('1 $DIG = 1000 base units', () => {
    expect(DIG_BASE_UNITS_PER_DIG).toBe(1000);
  });

  it('baseUnitsToDigString renders whole + fractional $DIG, trimming trailing zeros', () => {
    expect(baseUnitsToDigString(1000)).toBe('1');
    expect(baseUnitsToDigString(0)).toBe('0');
    expect(baseUnitsToDigString(500)).toBe('0.5');
    expect(baseUnitsToDigString(1)).toBe('0.001');
    expect(baseUnitsToDigString(1250)).toBe('1.25');
    expect(baseUnitsToDigString(1000005)).toBe('1000.005');
    // Never scientific notation, never float drift.
    expect(baseUnitsToDigString(10)).toBe('0.01');
  });

  it('baseUnitsToDigString defends garbage', () => {
    expect(baseUnitsToDigString(Number.NaN)).toBe('0');
    expect(baseUnitsToDigString(-5)).toBe('0');
  });

  it('digStringToBaseUnits parses ≤3-decimal $DIG to integer base units', () => {
    expect(digStringToBaseUnits('1')).toBe(1000);
    expect(digStringToBaseUnits('0.5')).toBe(500);
    expect(digStringToBaseUnits('1.25')).toBe(1250);
    expect(digStringToBaseUnits('0.001')).toBe(1);
    expect(digStringToBaseUnits('0')).toBe(0);
    expect(digStringToBaseUnits(' 2 ')).toBe(2000);
  });

  it('digStringToBaseUnits rejects malformed / >3-decimal amounts', () => {
    expect(digStringToBaseUnits('')).toBeNull();
    expect(digStringToBaseUnits('abc')).toBeNull();
    expect(digStringToBaseUnits('-1')).toBeNull();
    expect(digStringToBaseUnits('0.0001')).toBeNull(); // finer than DIG_DECIMALS
    expect(digStringToBaseUnits('1.2.3')).toBeNull();
  });

  it('isValidTipAmountDig requires a positive, ≤3-decimal amount', () => {
    expect(isValidTipAmountDig('1')).toBe(true);
    expect(isValidTipAmountDig('0.001')).toBe(true);
    expect(isValidTipAmountDig('0')).toBe(false);
    expect(isValidTipAmountDig('')).toBe(false);
    expect(isValidTipAmountDig('0.0001')).toBe(false);
    expect(isValidTipAmountDig('-2')).toBe(false);
  });
});

describe('tipping — mode + timeframe enums', () => {
  it('exposes the node canonical modes', () => {
    expect(TIP_MODES).toEqual(['per-site-per-day', 'daily-budget']);
    expect(isTipMode('per-site-per-day')).toBe(true);
    expect(isTipMode('daily-budget')).toBe(true);
    expect(isTipMode('per-day-period')).toBe(false); // the old ext-local token is NOT the node token
    expect(isTipMode(undefined)).toBe(false);
  });

  it('exposes the four timeframes', () => {
    expect(TIP_TIMEFRAMES).toEqual(['today', '7d', '30d', 'all']);
  });
});

describe('tipping — config normalization', () => {
  it('DEFAULT_TIPPING_CONFIG is safe (both policies present, off)', () => {
    expect(DEFAULT_TIPPING_CONFIG.creator.enabled).toBe(false);
    expect(DEFAULT_TIPPING_CONFIG.dev.enabled).toBe(false);
    expect(DEFAULT_AUTOTIP_POLICY.mode).toBe('per-site-per-day');
  });

  it('normalizeAutoTipPolicy coerces every field defensively', () => {
    const p = normalizeAutoTipPolicy({
      enabled: true,
      dig_amount: 1500,
      mode: 'daily-budget',
      per_site_cap: 5000,
      per_site_overrides: { store1: 2000, storeBad: 'x', storeNeg: -3 },
    });
    expect(p.enabled).toBe(true);
    expect(p.dig_amount).toBe(1500);
    expect(p.mode).toBe('daily-budget');
    expect(p.per_site_cap).toBe(5000);
    expect(p.per_site_overrides).toEqual({ store1: 2000 }); // bad + negative dropped
  });

  it('normalizeAutoTipPolicy falls back on garbage', () => {
    const p = normalizeAutoTipPolicy({ dig_amount: 'nope', mode: 'bogus' });
    expect(p.enabled).toBe(false);
    expect(p.dig_amount).toBe(0);
    expect(p.mode).toBe('per-site-per-day');
    expect(p.per_site_overrides).toEqual({});
  });

  it('normalizeTippingConfig fills both policies + caps', () => {
    const c = normalizeTippingConfig({ creator: { enabled: true, dig_amount: 1000 }, daily_total_cap: 10000, fee: 50 });
    expect(c.creator.enabled).toBe(true);
    expect(c.creator.dig_amount).toBe(1000);
    expect(c.dev.enabled).toBe(false); // absent → safe default
    expect(c.daily_total_cap).toBe(10000);
    expect(c.fee).toBe(50);
  });

  it('normalizeTippingConfig survives undefined', () => {
    const c = normalizeTippingConfig(undefined);
    expect(c.creator.enabled).toBe(false);
    expect(c.dev.enabled).toBe(false);
    expect(c.daily_total_cap).toBe(0);
  });
});

describe('tipping — ledger normalization', () => {
  const good = {
    id: 'abc',
    recipient_ph: 'ec7c30',
    store_id: 'store1',
    dig_amount: 1000,
    ts: 1_700_000_000,
    day: '2023-11-14',
    txid: 'deadbeef',
    trigger: 'manual',
    kind: 'creator',
    status: 'confirmed',
  };

  it('keeps a well-formed entry', () => {
    const e = normalizeLedgerEntry(good);
    expect(e).not.toBeNull();
    expect(e!.id).toBe('abc');
    expect(e!.dig_amount).toBe(1000);
    expect(e!.trigger).toBe('manual');
    expect(e!.kind).toBe('creator');
    expect(e!.status).toBe('confirmed');
  });

  it('defaults unknown enum fields to safe values', () => {
    const e = normalizeLedgerEntry({ ...good, trigger: 'x', kind: 'y', status: 'z' });
    expect(e!.trigger).toBe('auto');
    expect(e!.kind).toBe('creator');
    expect(e!.status).toBe('pending');
  });

  it('drops an entry with no id or bad amount', () => {
    expect(normalizeLedgerEntry({ ...good, id: '' })).toBeNull();
    expect(normalizeLedgerEntry({ ...good, dig_amount: 'nope' })).toBeNull();
    expect(normalizeLedgerEntry(null)).toBeNull();
  });

  it('normalizeLedger maps + filters an array (and defends non-arrays)', () => {
    const list = normalizeLedger([good, { id: '' }, { ...good, id: 'def' }]);
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.id)).toEqual(['abc', 'def']);
    expect(normalizeLedger(undefined)).toEqual([]);
    expect(normalizeLedger({ nope: 1 })).toEqual([]);
  });
});

describe('tipping — timeframe filtering', () => {
  // 2024-01-15T12:00:00Z
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);
  const mk = (id: string, tsMs: number): TipLedgerEntry => ({
    id,
    recipient_ph: 'ph',
    dig_amount: 1000,
    ts: Math.floor(tsMs / 1000), // node emits unix SECONDS
    trigger: 'auto',
    kind: 'creator',
    status: 'confirmed',
  });

  it('tipEntryMillis detects seconds vs milliseconds', () => {
    expect(tipEntryMillis({ ts: 1_700_000_000 })).toBe(1_700_000_000_000); // seconds → ms
    expect(tipEntryMillis({ ts: 1_700_000_000_000 })).toBe(1_700_000_000_000); // already ms
  });

  it('timeframeCutoffMs: today = start of UTC day; all = 0', () => {
    expect(timeframeCutoffMs('today', now)).toBe(Date.UTC(2024, 0, 15, 0, 0, 0));
    expect(timeframeCutoffMs('7d', now)).toBe(now - 7 * 86_400_000);
    expect(timeframeCutoffMs('30d', now)).toBe(now - 30 * 86_400_000);
    expect(timeframeCutoffMs('all', now)).toBe(0);
  });

  it('filters by timeframe window', () => {
    const entries = [
      mk('earlier-today', Date.UTC(2024, 0, 15, 6, 0, 0)),
      mk('yesterday', Date.UTC(2024, 0, 14, 12, 0, 0)),
      mk('tenDaysAgo', Date.UTC(2024, 0, 5, 12, 0, 0)),
      mk('fortyDaysAgo', Date.UTC(2023, 11, 6, 12, 0, 0)),
    ];
    expect(filterLedgerByTimeframe(entries, 'today', now).map((e) => e.id)).toEqual(['earlier-today']);
    expect(filterLedgerByTimeframe(entries, '7d', now).map((e) => e.id)).toEqual(['earlier-today', 'yesterday']);
    expect(filterLedgerByTimeframe(entries, '30d', now).map((e) => e.id)).toEqual([
      'earlier-today',
      'yesterday',
      'tenDaysAgo',
    ]);
    expect(filterLedgerByTimeframe(entries, 'all', now)).toHaveLength(4);
  });
});

describe('tipping — summary', () => {
  it('sums count + base units across shown entries', () => {
    const s = summarizeLedger([
      { id: 'a', recipient_ph: 'p', dig_amount: 1000, ts: 1, trigger: 'auto', kind: 'creator', status: 'confirmed' },
      { id: 'b', recipient_ph: 'p', dig_amount: 250, ts: 2, trigger: 'manual', kind: 'dev', status: 'pending' },
    ]);
    expect(s.count).toBe(2);
    expect(s.totalBaseUnits).toBe(1250);
  });

  it('empty ledger → zeroed summary', () => {
    expect(summarizeLedger([])).toEqual({ count: 0, totalBaseUnits: 0 });
  });
});

describe('tipping — editable form round-trip', () => {
  const cfg = {
    creator: { enabled: true, dig_amount: 1500, mode: 'daily-budget' as const, per_site_cap: 5000, per_site_overrides: { s1: 2000 } },
    dev: { enabled: false, dig_amount: 250, mode: 'per-site-per-day' as const, per_site_cap: 0, per_site_overrides: {} },
    daily_total_cap: 10000,
    fee: 42,
  };

  it('tipConfigToForm renders amounts as display strings', () => {
    const f = tipConfigToForm(cfg);
    expect(f.creator.amount).toBe('1.5');
    expect(f.creator.perSiteCap).toBe('5');
    expect(f.creator.mode).toBe('daily-budget');
    expect(f.creator.perSiteOverrides).toEqual({ s1: 2000 });
    expect(f.dev.amount).toBe('0.25');
    expect(f.dailyCap).toBe('10');
    expect(f.fee).toBe(42);
  });

  it('tipFormToConfig is the inverse (preserves fee + overrides)', () => {
    const back = tipFormToConfig(tipConfigToForm(cfg));
    expect(back).toEqual(cfg);
  });

  it('tipFormToConfig returns null when an amount field is malformed', () => {
    const f = tipConfigToForm(cfg);
    f.creator.amount = '1.2.3';
    expect(tipFormToConfig(f)).toBeNull();
    expect(isTipFormValid(f)).toBe(false);
  });

  it('isAmountField accepts 0 + positive, rejects empty/negative/over-precise', () => {
    expect(isAmountField('0')).toBe(true);
    expect(isAmountField('1.25')).toBe(true);
    expect(isAmountField('')).toBe(false);
    expect(isAmountField('-1')).toBe(false);
    expect(isAmountField('0.0001')).toBe(false);
  });
});
