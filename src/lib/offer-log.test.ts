import { describe, it, expect } from 'vitest';
import {
  logKey,
  entriesFor,
  appendOfferEntry,
  markOfferStatus,
  MAX_OFFER_LOG_ENTRIES,
  type OfferLogState,
  type OfferLogEntry,
} from '@/lib/offer-log';

function entry(over: Partial<OfferLogEntry> = {}): OfferLogEntry {
  return {
    id: over.id ?? 'offer:coin1',
    offer: over.offer ?? 'offer1qqqmadeqqq',
    summary: over.summary ?? { offered: [{ asset: { kind: 'xch' }, amount: '100' }], requested: [{ asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: '5', toPuzzleHashHex: 'ab' }] },
    coinIdHex: over.coinIdHex ?? 'coin1',
    createdAt: over.createdAt ?? 1000,
    status: over.status ?? 'open',
  };
}

describe('offer-log (#101 — local saved/active offer tracking)', () => {
  describe('logKey / entriesFor', () => {
    it('composes a per-wallet+index key (same scheme as activity-log)', () => {
      expect(logKey('w1', 0)).toBe('w1:0');
      expect(logKey('w1', 3)).toBe('w1:3');
    });

    it('returns [] for an unknown scope, missing state, or a malformed value', () => {
      expect(entriesFor(undefined, 'w1', 0)).toEqual([]);
      expect(entriesFor(null, 'w1', 0)).toEqual([]);
      expect(entriesFor({}, 'w1', 0)).toEqual([]);
      expect(entriesFor({ 'w1:0': 'not-an-array' } as unknown as OfferLogState, 'w1', 0)).toEqual([]);
    });
  });

  describe('appendOfferEntry', () => {
    it('appends newest-first', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a', coinIdHex: 'a' }));
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'b', coinIdHex: 'b' }));
      expect(entriesFor(state, 'w1', 0).map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('isolates entries per wallet+index — a write to one scope never leaks into another', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'wallet-A', 0, entry({ id: 'a1' }));
      state = appendOfferEntry(state, 'wallet-B', 0, entry({ id: 'b1' }));
      state = appendOfferEntry(state, 'wallet-A', 1, entry({ id: 'a-idx1' }));
      expect(entriesFor(state, 'wallet-A', 0).map((e) => e.id)).toEqual(['a1']);
      expect(entriesFor(state, 'wallet-B', 0).map((e) => e.id)).toEqual(['b1']);
      expect(entriesFor(state, 'wallet-A', 1).map((e) => e.id)).toEqual(['a-idx1']);
    });

    it('is idempotent on a repeat id (a retried record-offer call never duplicates a row)', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a' }));
      const before = state;
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a', createdAt: 9999 }));
      expect(state).toBe(before); // unchanged reference — proves the no-op path
      expect(entriesFor(state, 'w1', 0)).toHaveLength(1);
    });

    it('ring-buffers at MAX_OFFER_LOG_ENTRIES, dropping the oldest', () => {
      let state: OfferLogState = {};
      for (let i = 0; i < MAX_OFFER_LOG_ENTRIES + 5; i++) {
        state = appendOfferEntry(state, 'w1', 0, entry({ id: `o${i}`, coinIdHex: `c${i}` }));
      }
      const ids = entriesFor(state, 'w1', 0).map((e) => e.id);
      expect(ids).toHaveLength(MAX_OFFER_LOG_ENTRIES);
      expect(ids[0]).toBe(`o${MAX_OFFER_LOG_ENTRIES + 4}`); // newest kept
      expect(ids).not.toContain('o0'); // oldest dropped
    });
  });

  describe('markOfferStatus', () => {
    it('flips an OPEN entry matched by coinIdHex to the given status', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a', coinIdHex: 'coinA', status: 'open' }));
      state = markOfferStatus(state, 'w1', 0, 'coinA', 'taken');
      expect(entriesFor(state, 'w1', 0)[0].status).toBe('taken');
    });

    it('returns the SAME state reference when no entry matches (cheap no-op check)', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a', coinIdHex: 'coinA', status: 'open' }));
      const before = state;
      const after = markOfferStatus(state, 'w1', 0, 'does-not-exist', 'taken');
      expect(after).toBe(before);
    });

    it('never re-flips an already non-open entry (cancelled stays cancelled, not overwritten to taken)', () => {
      let state: OfferLogState = {};
      state = appendOfferEntry(state, 'w1', 0, entry({ id: 'a', coinIdHex: 'coinA', status: 'cancelled' }));
      const before = state;
      const after = markOfferStatus(state, 'w1', 0, 'coinA', 'taken');
      expect(after).toBe(before);
      expect(entriesFor(after, 'w1', 0)[0].status).toBe('cancelled');
    });

    it('is a no-op on an empty/unknown scope', () => {
      const state: OfferLogState = {};
      expect(markOfferStatus(state, 'w1', 0, 'coinA', 'taken')).toBe(state);
    });
  });
});
