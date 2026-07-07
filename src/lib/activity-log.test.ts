import { describe, it, expect } from 'vitest';
import {
  logKey,
  entriesFor,
  appendActivityEntry,
  appendActivityEntries,
  markEntryConfirmed,
  detectReceivedEntries,
  MAX_ACTIVITY_LOG_ENTRIES,
  type ActivityLogState,
  type LocalActivityEntry,
} from '@/lib/activity-log';

function entry(over: Partial<LocalActivityEntry> = {}): LocalActivityEntry {
  return {
    id: over.id ?? 's:coin1',
    kind: over.kind ?? 'sent',
    asset: over.asset ?? 'XCH',
    amount: over.amount ?? '1000',
    counterparty: over.counterparty ?? 'xch1recipient',
    coinId: over.coinId ?? 'coin1',
    timestamp: over.timestamp ?? 1000,
    status: over.status ?? 'pending',
  };
}

describe('activity-log (#154 — local MetaMask-style tracking)', () => {
  describe('logKey / entriesFor', () => {
    it('composes a per-wallet+index key', () => {
      expect(logKey('w1', 0)).toBe('w1:0');
      expect(logKey('w1', 3)).toBe('w1:3');
    });

    it('returns [] for an unknown scope, missing state, or a malformed value', () => {
      expect(entriesFor(undefined, 'w1', 0)).toEqual([]);
      expect(entriesFor(null, 'w1', 0)).toEqual([]);
      expect(entriesFor({}, 'w1', 0)).toEqual([]);
      expect(entriesFor({ 'w1:0': 'not-an-array' } as unknown as ActivityLogState, 'w1', 0)).toEqual([]);
    });
  });

  describe('appendActivityEntry', () => {
    it('appends newest-first', () => {
      let state: ActivityLogState = {};
      state = appendActivityEntry(state, 'w1', 0, entry({ id: 'a', coinId: 'a' }));
      state = appendActivityEntry(state, 'w1', 0, entry({ id: 'b', coinId: 'b' }));
      expect(entriesFor(state, 'w1', 0).map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('isolates entries per wallet+index — a write to one scope never leaks into another', () => {
      let state: ActivityLogState = {};
      state = appendActivityEntry(state, 'wallet-A', 0, entry({ id: 'a1' }));
      state = appendActivityEntry(state, 'wallet-B', 0, entry({ id: 'b1' }));
      state = appendActivityEntry(state, 'wallet-A', 1, entry({ id: 'a-idx1' }));
      expect(entriesFor(state, 'wallet-A', 0).map((e) => e.id)).toEqual(['a1']);
      expect(entriesFor(state, 'wallet-B', 0).map((e) => e.id)).toEqual(['b1']);
      expect(entriesFor(state, 'wallet-A', 1).map((e) => e.id)).toEqual(['a-idx1']);
    });

    it('is idempotent on a repeat id (a retried confirm callback never duplicates a row)', () => {
      let state: ActivityLogState = {};
      const e = entry({ id: 'dup', coinId: 'dup' });
      state = appendActivityEntry(state, 'w1', 0, e);
      const again = appendActivityEntry(state, 'w1', 0, e);
      expect(again).toBe(state); // same reference: a true no-op, not just equal content
      expect(entriesFor(state, 'w1', 0)).toHaveLength(1);
    });

    it('ring-buffers at MAX_ACTIVITY_LOG_ENTRIES, dropping the oldest', () => {
      let state: ActivityLogState = {};
      for (let i = 0; i < MAX_ACTIVITY_LOG_ENTRIES + 10; i++) {
        state = appendActivityEntry(state, 'w1', 0, entry({ id: `e${i}`, coinId: `e${i}` }));
      }
      const rows = entriesFor(state, 'w1', 0);
      expect(rows).toHaveLength(MAX_ACTIVITY_LOG_ENTRIES);
      // Newest (last appended) survives at the front; the oldest 10 were evicted.
      expect(rows[0].id).toBe(`e${MAX_ACTIVITY_LOG_ENTRIES + 9}`);
      expect(rows.some((r) => r.id === 'e0')).toBe(false);
    });

    it('does not mutate the input state (pure/immutable)', () => {
      const state: ActivityLogState = {};
      const frozen = Object.freeze({ ...state });
      expect(() => appendActivityEntry(frozen, 'w1', 0, entry())).not.toThrow();
    });
  });

  describe('appendActivityEntries (batch)', () => {
    it('appends several entries in one pass, preserving newest-first order', () => {
      const state = appendActivityEntries({}, 'w1', 0, [
        entry({ id: 'r1', coinId: null, kind: 'received' }),
        entry({ id: 'r2', coinId: null, kind: 'received' }),
      ]);
      expect(entriesFor(state, 'w1', 0).map((e) => e.id)).toEqual(['r2', 'r1']);
    });
  });

  describe('markEntryConfirmed', () => {
    it('flips a matching pending entry to confirmed', () => {
      let state: ActivityLogState = appendActivityEntry({}, 'w1', 0, entry({ id: 's:c1', coinId: 'c1', status: 'pending' }));
      state = markEntryConfirmed(state, 'w1', 0, 'c1');
      expect(entriesFor(state, 'w1', 0)[0].status).toBe('confirmed');
    });

    it('is a true no-op (same reference) when the coinId is not found', () => {
      const state = appendActivityEntry({}, 'w1', 0, entry({ id: 's:c1', coinId: 'c1' }));
      const next = markEntryConfirmed(state, 'w1', 0, 'unknown-coin');
      expect(next).toBe(state);
    });

    it('is a true no-op when the scope has no entries at all', () => {
      const state: ActivityLogState = {};
      expect(markEntryConfirmed(state, 'w1', 0, 'c1')).toBe(state);
    });

    it('is a true no-op when the matching entry is already confirmed', () => {
      const state = appendActivityEntry({}, 'w1', 0, entry({ id: 's:c1', coinId: 'c1', status: 'confirmed' }));
      expect(markEntryConfirmed(state, 'w1', 0, 'c1')).toBe(state);
    });

    it('only touches the matching wallet+index scope', () => {
      let state: ActivityLogState = appendActivityEntry({}, 'wallet-A', 0, entry({ id: 's:c1', coinId: 'c1' }));
      state = appendActivityEntry(state, 'wallet-B', 0, entry({ id: 's:c1-b', coinId: 'c1' }));
      state = markEntryConfirmed(state, 'wallet-A', 0, 'c1');
      expect(entriesFor(state, 'wallet-A', 0)[0].status).toBe('confirmed');
      expect(entriesFor(state, 'wallet-B', 0)[0].status).toBe('pending');
    });
  });

  describe('detectReceivedEntries (balance-delta receive detection)', () => {
    it('emits a received XCH entry when the balance increased', () => {
      const out = detectReceivedEntries({ xch: 1000, cats: {} }, { xch: 1500, cats: {} }, 42);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: 'received', asset: 'XCH', amount: '500', status: 'confirmed', coinId: null, timestamp: 42 });
    });

    it('emits a received CAT entry keyed by assetId when a watched CAT balance increased', () => {
      const out = detectReceivedEntries({ xch: 0, cats: { deadbeef: 100 } }, { xch: 0, cats: { deadbeef: 300 } }, 1);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: 'received', asset: 'deadbeef', amount: '200' });
    });

    it('emits nothing when nothing changed', () => {
      expect(detectReceivedEntries({ xch: 1000, cats: { a: 5 } }, { xch: 1000, cats: { a: 5 } }, 1)).toEqual([]);
    });

    it('emits nothing on a decrease (a spend is logged at send-time, never reconstructed here)', () => {
      expect(detectReceivedEntries({ xch: 1000, cats: {} }, { xch: 400, cats: {} }, 1)).toEqual([]);
    });

    it('treats a missing prior snapshot as a 0 baseline (caller decides whether to skip the call)', () => {
      const out = detectReceivedEntries(null, { xch: 100, cats: {} }, 1);
      expect(out).toHaveLength(1);
      expect(out[0].amount).toBe('100');
    });

    it('emits one entry per newly-increased CAT, ignoring unchanged/decreased ones, in the same call', () => {
      const out = detectReceivedEntries(
        { xch: 100, cats: { up: 10, flat: 5, down: 50 } },
        { xch: 100, cats: { up: 40, flat: 5, down: 20 } },
        7,
      );
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ asset: 'up', amount: '30' });
    });

    it('gives every emitted entry a distinct id even within the same millisecond', () => {
      const out = detectReceivedEntries({ xch: 0, cats: { a: 0, b: 0 } }, { xch: 10, cats: { a: 10, b: 10 } }, 999);
      const ids = out.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
