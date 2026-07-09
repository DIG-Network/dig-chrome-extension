/**
 * The LOCAL option-contract registry (#104) — persists the full off-chain terms of every option
 * this wallet has MINTED (`prepareOptionMint`), mirroring #101's offer-log shape/idioms exactly (a
 * flat map keyed by {@link logKey}, `"<walletId>:<activeIndex>"`, → that scope's own ring-buffered
 * entry array, newest first). This is the ONLY record of an option's strike/expiration/creator the
 * chain doesn't hand back for a bare singleton — see `optionContracts.ts`'s module doc for why (a
 * bare on-chain option carries no recoverable terms without them being published out-of-band).
 *
 * Status is derived from on-chain coin-spent polling, exactly like the offer log: `coinIdHex` (the
 * option's current, post-mint-commit coin id) is the poll key; once observed spent, the entry flips
 * 'open' → 'exercised' (MVP has no clawback path yet, so "spent" only ever means exercised).
 *
 * PURE (no chrome.* / DOM), fully unit-tested; `src/background/index.ts` owns the
 * `chrome.storage.local` read-modify-write around these helpers (mirrors `offer-log.ts`'s split).
 */

import type { OptionRecord } from '@/offscreen/optionContracts';

/** The status of a minted option, derived from on-chain coin-spent polling (see the module doc). */
export type OptionStatus = 'open' | 'exercised';

/** One entry in the local option registry — an option THIS wallet minted via `prepareOptionMint`. */
export interface OptionLogEntry {
  /** The full off-chain terms `prepareOptionExercise` needs (also doubles as a stable id — a
   * launcher id is unique per option). */
  record: OptionRecord;
  /** When this option was minted (ms epoch). */
  createdAt: number;
  status: OptionStatus;
}

/** Ring-buffer cap per wallet+index scope — bounds `chrome.storage.local` growth indefinitely. */
export const MAX_OPTION_LOG_ENTRIES = 200;

/** The composite storage-map key for one wallet's one active derivation index (#90, #165) — the
 * SAME scheme as `offer-log.ts`'s `logKey`. */
export function logKey(walletId: string, index: number): string {
  return `${walletId}:${index}`;
}

/** The persisted shape of `chrome.storage.local[OPTION_LOG_KEY]`. */
export type OptionLogState = Record<string, OptionLogEntry[]>;

/** Read one wallet+index scope's entries (newest-first), or `[]` when nothing has been minted yet. */
export function optionEntriesFor(state: OptionLogState | null | undefined, walletId: string, index: number): OptionLogEntry[] {
  if (!state || typeof state !== 'object') return [];
  const entries = state[logKey(walletId, index)];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Append one minted option to a wallet+index scope, newest-first, ring-buffer capped at
 * {@link MAX_OPTION_LOG_ENTRIES}. Idempotent on a repeat `record.launcherId` (a retried mint-record
 * call must never duplicate a row). Immutable; other scopes are untouched.
 */
export function appendOptionEntry(state: OptionLogState, walletId: string, index: number, entry: OptionLogEntry): OptionLogState {
  const key = logKey(walletId, index);
  const existing = state[key] ?? [];
  if (existing.some((e) => e.record.launcherId === entry.record.launcherId)) return state;
  const next = [entry, ...existing].slice(0, MAX_OPTION_LOG_ENTRIES);
  return { ...state, [key]: next };
}

/**
 * Flip an OPEN entry (matched by `coinIdHex`, within one wallet+index scope) to `status`. Returns
 * the SAME `state` reference (no-op) when nothing matches or the match is already non-'open' (a
 * terminal state never re-flips), so the caller can skip a redundant `chrome.storage.local.set`.
 */
export function markOptionStatus(state: OptionLogState, walletId: string, index: number, coinIdHex: string, status: OptionStatus): OptionLogState {
  const key = logKey(walletId, index);
  const existing = state[key];
  if (!existing) return state;
  let changed = false;
  const next = existing.map((e) => {
    if (e.record.coinIdHex === coinIdHex && e.status === 'open') {
      changed = true;
      return { ...e, status };
    }
    return e;
  });
  return changed ? { ...state, [key]: next } : state;
}
