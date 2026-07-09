import { describe, it, expect } from 'vitest';
import {
  logKey,
  optionEntriesFor,
  appendOptionEntry,
  markOptionStatus,
  MAX_OPTION_LOG_ENTRIES,
  type OptionLogState,
  type OptionLogEntry,
} from '@/lib/optionContractLog';
import type { OptionRecord } from '@/offscreen/optionContracts';

function record(over: Partial<OptionRecord> = {}): OptionRecord {
  return {
    launcherId: over.launcherId ?? 'aa'.repeat(32),
    creatorPuzzleHashHex: over.creatorPuzzleHashHex ?? 'bb'.repeat(32),
    holderPuzzleHashHex: over.holderPuzzleHashHex ?? 'bb'.repeat(32),
    expirationSeconds: over.expirationSeconds ?? '9999999999',
    underlyingAmount: over.underlyingAmount ?? '1000000000000',
    strikeAmount: over.strikeAmount ?? '500000000000',
    underlyingLockParentCoinId: over.underlyingLockParentCoinId ?? 'cc'.repeat(32),
    coinIdHex: over.coinIdHex ?? 'coin1',
  };
}

function entry(over: Partial<OptionLogEntry> = {}): OptionLogEntry {
  return {
    record: over.record ?? record(),
    createdAt: over.createdAt ?? 1000,
    status: over.status ?? 'open',
  };
}

describe('optionContractLog (#104 — local minted-option tracking)', () => {
  describe('logKey / optionEntriesFor', () => {
    it('composes a per-wallet+index key (same scheme as offer-log/activity-log)', () => {
      expect(logKey('w1', 0)).toBe('w1:0');
      expect(logKey('w1', 3)).toBe('w1:3');
    });

    it('returns [] for an unknown scope, missing state, or a malformed value', () => {
      expect(optionEntriesFor(undefined, 'w1', 0)).toEqual([]);
      expect(optionEntriesFor(null, 'w1', 0)).toEqual([]);
      expect(optionEntriesFor({}, 'w1', 0)).toEqual([]);
      expect(optionEntriesFor({ 'w1:0': 'not-an-array' } as unknown as OptionLogState, 'w1', 0)).toEqual([]);
    });
  });

  describe('appendOptionEntry', () => {
    it('appends newest-first', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ launcherId: 'a'.repeat(64), coinIdHex: 'a' }) }));
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ launcherId: 'b'.repeat(64), coinIdHex: 'b' }) }));
      expect(optionEntriesFor(state, 'w1', 0).map((e) => e.record.launcherId)).toEqual(['b'.repeat(64), 'a'.repeat(64)]);
    });

    it('isolates entries per wallet+index — a write to one scope never leaks into another', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'wallet-A', 0, entry({ record: record({ launcherId: 'a1'.padEnd(64, '0') }) }));
      state = appendOptionEntry(state, 'wallet-B', 0, entry({ record: record({ launcherId: 'b1'.padEnd(64, '0') }) }));
      state = appendOptionEntry(state, 'wallet-A', 1, entry({ record: record({ launcherId: 'a2'.padEnd(64, '0') }) }));
      expect(optionEntriesFor(state, 'wallet-A', 0)).toHaveLength(1);
      expect(optionEntriesFor(state, 'wallet-B', 0)).toHaveLength(1);
      expect(optionEntriesFor(state, 'wallet-A', 1)).toHaveLength(1);
    });

    it('is idempotent on a repeat launcherId (a retried mint-record call never duplicates a row)', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ launcherId: 'a'.repeat(64) }) }));
      const before = state;
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ launcherId: 'a'.repeat(64) }), createdAt: 9999 }));
      expect(state).toBe(before); // unchanged reference — proves the no-op path
      expect(optionEntriesFor(state, 'w1', 0)).toHaveLength(1);
    });

    it('ring-buffers at MAX_OPTION_LOG_ENTRIES, dropping the oldest', () => {
      let state: OptionLogState = {};
      for (let i = 0; i < MAX_OPTION_LOG_ENTRIES + 5; i++) {
        const id = i.toString(16).padStart(64, '0');
        state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ launcherId: id, coinIdHex: `c${i}` }) }));
      }
      const ids = optionEntriesFor(state, 'w1', 0).map((e) => e.record.coinIdHex);
      expect(ids).toHaveLength(MAX_OPTION_LOG_ENTRIES);
      expect(ids[0]).toBe(`c${MAX_OPTION_LOG_ENTRIES + 4}`); // newest kept
      expect(ids).not.toContain('c0'); // oldest dropped
    });
  });

  describe('markOptionStatus', () => {
    it('flips an OPEN entry matched by coinIdHex to the given status', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ coinIdHex: 'coinA' }), status: 'open' }));
      state = markOptionStatus(state, 'w1', 0, 'coinA', 'exercised');
      expect(optionEntriesFor(state, 'w1', 0)[0].status).toBe('exercised');
    });

    it('returns the SAME state reference when no entry matches (cheap no-op check)', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ coinIdHex: 'coinA' }), status: 'open' }));
      const before = state;
      const after = markOptionStatus(state, 'w1', 0, 'does-not-exist', 'exercised');
      expect(after).toBe(before);
    });

    it('never re-flips an already non-open entry', () => {
      let state: OptionLogState = {};
      state = appendOptionEntry(state, 'w1', 0, entry({ record: record({ coinIdHex: 'coinA' }), status: 'exercised' }));
      const before = state;
      const after = markOptionStatus(state, 'w1', 0, 'coinA', 'exercised');
      expect(after).toBe(before);
    });

    it('is a no-op on an empty/unknown scope', () => {
      const state: OptionLogState = {};
      expect(markOptionStatus(state, 'w1', 0, 'coinA', 'exercised')).toBe(state);
    });
  });
});
