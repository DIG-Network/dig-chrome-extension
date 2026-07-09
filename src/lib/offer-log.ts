/**
 * The LOCAL offer log (#101) — persists shareable offers this wallet has MADE (`makeOffer`) so the
 * fullscreen "Your offers" panel can list them, re-share (copy/QR) an open one, cancel it, and see
 * its status update over time — a MetaMask/dexie-"My offers"-style ledger, mirroring the #154 local
 * activity log's storage shape and idioms (`lib/activity-log.ts`): a flat map keyed by
 * {@link logKey} (`"<walletId>:<activeIndex>"`) → that scope's own ring-buffered entry array
 * (newest first, capped at {@link MAX_OFFER_LOG_ENTRIES}).
 *
 * Status is derived from on-chain coin-spent polling, NOT a push notification (Chia offers have no
 * "someone took my offer" event): `coinIdHex` is one of the offer's real OFFERED coin ids (any one
 * suffices — the maker's spend consumes them all atomically together, see `offers.ts`'s
 * `MadeOffer.offeredCoinIdsHex`); once that coin is observed spent, the entry is 'taken' UNLESS the
 * wallet itself performed the spend via `prepareTrade`'s 'cancel' path, in which case the SW eagerly
 * flips it to 'cancelled' at confirm time (before any status poll would guess 'taken'). 'expired' is
 * a RESERVED status (like `activity-log.ts`'s reserved `offer`/`clawback`/`melt` kinds) for a future
 * offer-expiry-timestamp feature — the current offer engine does not set one, so it is never emitted.
 *
 * This module is PURE (no chrome.* / DOM), so it is fully unit-tested; `src/background/index.ts`
 * owns the `chrome.storage.local` read-modify-write around these helpers (mirrors `activity-log.ts`'s
 * split).
 */

import type { WireOfferSummary } from '@/offscreen/vault';

/** The status of a MADE offer, derived from on-chain coin-spent polling (see the module doc). */
export type OfferStatus = 'open' | 'taken' | 'cancelled' | 'expired';

/** One entry in the local offer log — an offer THIS wallet made via `makeOffer`. */
export interface OfferLogEntry {
  /** Stable id for React keys + de-dupe (`appendOfferEntry` is idempotent on a repeat id). */
  id: string;
  /** The shareable `offer1…` string — kept so "re-share" can show the copy/QR again with no rebuild. */
  offer: string;
  /** The two-sided summary decoded at make-time (what was offered vs requested). */
  summary: WireOfferSummary;
  /** One of the offer's real offered coin ids (hex) — the poll key for status; `null` only for a
   * pathological entry with no offered coins (never produced by `makeOffer` in practice). */
  coinIdHex: string | null;
  /** When this offer was made (ms epoch). */
  createdAt: number;
  status: OfferStatus;
}

/** Ring-buffer cap per wallet+index scope — bounds `chrome.storage.local` growth indefinitely. */
export const MAX_OFFER_LOG_ENTRIES = 200;

/** The composite storage-map key for one wallet's one active derivation index (#90, #165) — the
 * SAME scheme as `activity-log.ts`'s `logKey`. */
export function logKey(walletId: string, index: number): string {
  return `${walletId}:${index}`;
}

/** The persisted shape of `chrome.storage.local[OFFER_LOG_KEY]`: every wallet+index scope's own
 * entry array, newest-first. Absent scopes simply have no key yet (never an error). */
export type OfferLogState = Record<string, OfferLogEntry[]>;

/** Read one wallet+index scope's entries (newest-first), or `[]` when nothing has been made yet (a
 * fresh wallet/index, or a state that predates this feature). Never throws on a malformed state. */
export function entriesFor(state: OfferLogState | null | undefined, walletId: string, index: number): OfferLogEntry[] {
  if (!state || typeof state !== 'object') return [];
  const entries = state[logKey(walletId, index)];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Append one entry to a wallet+index scope, newest-first, ring-buffer capped at
 * {@link MAX_OFFER_LOG_ENTRIES}. Idempotent on a repeat `entry.id` (returns `state` unchanged — a
 * retried record-offer call must never duplicate a row). Immutable; other scopes are untouched.
 */
export function appendOfferEntry(state: OfferLogState, walletId: string, index: number, entry: OfferLogEntry): OfferLogState {
  const key = logKey(walletId, index);
  const existing = state[key] ?? [];
  if (existing.some((e) => e.id === entry.id)) return state;
  const next = [entry, ...existing].slice(0, MAX_OFFER_LOG_ENTRIES);
  return { ...state, [key]: next };
}

/**
 * Flip an OPEN entry (matched by `coinIdHex`, within one wallet+index scope) to `status` — either
 * the SW's on-chain poll observing the coin spent ('taken') or an eager flip at `confirmTrade`
 * ('cancel') time. Returns the SAME `state` reference (no-op) when the scope has no entries, no
 * entry matches `coinIdHex`, or the match is already non-'open' (a cancelled/taken entry is a
 * terminal state — it is never re-flipped by a later poll), so the caller can skip a redundant
 * `chrome.storage.local.set` via a reference check.
 */
export function markOfferStatus(state: OfferLogState, walletId: string, index: number, coinIdHex: string, status: OfferStatus): OfferLogState {
  const key = logKey(walletId, index);
  const existing = state[key];
  if (!existing) return state;
  let changed = false;
  const next = existing.map((e) => {
    if (e.coinIdHex === coinIdHex && e.status === 'open') {
      changed = true;
      return { ...e, status };
    }
    return e;
  });
  return changed ? { ...state, [key]: next } : state;
}
