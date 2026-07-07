/**
 * The LOCAL activity log (#154) — a MetaMask-style transaction history: the extension writes an
 * entry the moment IT performs an action (send/mint/DID/offer/trade), starting `pending`, flipped
 * to `confirmed` by the existing confirm-poll (`sendStatus`/`coinConfirmed`). Receives are detected
 * cheaply from the balance scan's own before/after delta — there is NO separate on-chain history
 * scan. This REPLACES the old `src/offscreen/activity.ts` `indexActivity` full-history
 * (`includeSpent: true`) coinset reconstruction, which was too heavy for a wallet with deep history
 * (the root cause of #154's "Activity never loads" bug) and required no local tracking at all.
 *
 * Storage shape (`chrome.storage.local[ACTIVITY_LOG_KEY]`, §5): a flat map keyed by
 * {@link logKey} (`"<walletId>:<activeIndex>"`) → that scope's own ring-buffered entry array
 * (newest first, capped at {@link MAX_ACTIVITY_LOG_ENTRIES}). Unlike `walletCache.balances` /
 * the old `walletCache.activity`, this key is NEVER cleared on wallet switch or index navigation
 * (`clearActiveWalletCaches`) — it is durable history, not a re-fetchable cache. Per-wallet +
 * per-active-index isolation (#90, #165) comes from the composite key alone: switching back to a
 * wallet/index later reads exactly the slice that scope wrote.
 *
 * This module is PURE (no chrome.* / DOM / crypto) so it is fully unit-tested; `src/background/
 * index.ts` owns the `chrome.storage.local` read-modify-write around these helpers (mirrors the
 * `wallet-registry.ts` / `custody-session.ts` pattern).
 */

/**
 * The kinds of local activity an entry can record. `sent` / `received` / `mint` / `did` / `trade` /
 * `burn` are currently EMITTED (wired in `src/background/index.ts`); `offer` / `clawback` / `melt`
 * are reserved schema members for a tracked follow-up:
 *  - `offer` (making/publishing a shareable offer) has no coin spent yet to poll for confirmation
 *    — the spend happens only if/when a counterparty takes it, possibly from another wallet
 *    entirely, so it doesn't fit the pending→confirmed poll model this module implements.
 *  - `clawback` / `melt` have no corresponding custody action yet.
 * `burn` (#171 — Collectibles bulk destructive burn) is DISTINCT from `sent`: the destination has no
 * spending key (it is the well-known provably-unspendable puzzle hash), so it is never logged with a
 * counterparty, and the ledger shows it as an irreversible burn rather than a transfer to someone.
 * The UI (`activityRows.ts` / `CustodyActivity.tsx`) still renders all nine so a future entry never
 * hits an unhandled-kind gap.
 */
export type ActivityKind = 'sent' | 'received' | 'mint' | 'did' | 'offer' | 'trade' | 'clawback' | 'melt' | 'burn';

/** `pending` — logged the moment the extension broadcast the spend; `confirmed` — the confirm-poll
 * (`sendStatus` → `coinConfirmed`) saw the input coin spent on-chain. A `received` entry (detected
 * from an already-settled balance delta) is logged straight to `confirmed` — there is no "pending
 * receive" state to observe. */
export type ActivityStatus = 'pending' | 'confirmed';

/** One local activity-log entry — the extension's own record of an action it took (or observed via
 * a balance-delta receive), NOT a reconstruction from an on-chain scan. */
export interface LocalActivityEntry {
  /** Stable id for React keys + de-dupe (`appendActivityEntry` is idempotent on a repeat id). */
  id: string;
  kind: ActivityKind;
  /** `'XCH'`, a CAT asset id (TAIL hex), or a synthetic label (`'NFT'`/`'DID'`) for a non-token spend. */
  asset: string;
  /** Amount in base units (mojos / CAT base units); `'0'`/`'1'` for a non-token spend (NFT/DID). */
  amount: string;
  /** The counterparty address for a send-like entry, or `null` (self-only spend / unknown / receive). */
  counterparty: string | null;
  /** The relevant coin id (hex, no `0x`) — the confirm-poll's match key; `null` only for a
   * best-effort `received` entry with no specific coin attributed (a pure balance delta). */
  coinId: string | null;
  /** When this entry was logged (ms epoch) — NOT a block time (the extension isn't scanning chain). */
  timestamp: number;
  status: ActivityStatus;
  /**
   * #152 — present ONLY on a 'sent' entry that used a clawback window: the locked coin's params, so
   * the fullscreen Clawback panel can list this as a pending OUTGOING candidate (re-checked against
   * live chain state via `listClawbacks` — the vault has no other way to enumerate a wallet's own
   * past clawback sends). Absent on every other entry, including a plain (non-clawback) 'sent'.
   */
  clawback?: { senderPuzzleHashHex: string; receiverPuzzleHashHex: string; seconds: string; amount: string };
}

/** Ring-buffer cap per wallet+index scope — bounds `chrome.storage.local` growth indefinitely. */
export const MAX_ACTIVITY_LOG_ENTRIES = 200;

/** The composite storage-map key for one wallet's one active derivation index (#90, #165). */
export function logKey(walletId: string, index: number): string {
  return `${walletId}:${index}`;
}

/** The persisted shape of `chrome.storage.local[ACTIVITY_LOG_KEY]`: every wallet+index scope's own
 * entry array, newest-first. Absent scopes simply have no key yet (never an error). */
export type ActivityLogState = Record<string, LocalActivityEntry[]>;

/** Read one wallet+index scope's entries (newest-first), or `[]` when nothing has been logged yet
 * (a fresh wallet/index, or a state that predates this feature). Never throws on a malformed state. */
export function entriesFor(state: ActivityLogState | null | undefined, walletId: string, index: number): LocalActivityEntry[] {
  if (!state || typeof state !== 'object') return [];
  const entries = state[logKey(walletId, index)];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Append one entry to a wallet+index scope, newest-first, ring-buffer capped at
 * {@link MAX_ACTIVITY_LOG_ENTRIES}. Idempotent on a repeat `entry.id` (returns `state` unchanged —
 * a retried `confirmSend`/`sendStatus` callback must never duplicate a row). Immutable; other
 * scopes are untouched.
 */
export function appendActivityEntry(state: ActivityLogState, walletId: string, index: number, entry: LocalActivityEntry): ActivityLogState {
  const key = logKey(walletId, index);
  const existing = state[key] ?? [];
  if (existing.some((e) => e.id === entry.id)) return state;
  const next = [entry, ...existing].slice(0, MAX_ACTIVITY_LOG_ENTRIES);
  return { ...state, [key]: next };
}

/** Append several entries (e.g. a balance scan's multiple simultaneous receives) in one pass. */
export function appendActivityEntries(state: ActivityLogState, walletId: string, index: number, entries: LocalActivityEntry[]): ActivityLogState {
  return entries.reduce((acc, e) => appendActivityEntry(acc, walletId, index, e), state);
}

/**
 * Flip a `pending` entry (matched by `coinId`, within one wallet+index scope) to `confirmed` — the
 * confirm-poll callback (`sendStatus` reporting `coinConfirmed`). Returns the SAME `state` reference
 * (no-op) when the scope has no entries, no entry matches `coinId`, or the match is already
 * `confirmed` — so the caller can skip a redundant `chrome.storage.local.set` via a reference check.
 */
export function markEntryConfirmed(state: ActivityLogState, walletId: string, index: number, coinId: string): ActivityLogState {
  const key = logKey(walletId, index);
  const existing = state[key];
  if (!existing) return state;
  let changed = false;
  const next = existing.map((e) => {
    if (e.coinId === coinId && e.status === 'pending') {
      changed = true;
      return { ...e, status: 'confirmed' as const };
    }
    return e;
  });
  return changed ? { ...state, [key]: next } : state;
}

/** The minimal balance shape {@link detectReceivedEntries} diffs — structurally matches
 * `offscreen/scan.ts`'s `BalanceScan` (base-unit numeric amounts) without importing across the
 * background/offscreen boundary. */
export interface BalanceSnapshot {
  xch: number;
  cats: Record<string, number>;
}

/**
 * Balance-delta receive detection (#154's replacement for a full on-chain activity scan): compare
 * the balance snapshot from the wallet's PREVIOUS scan against its latest one and emit a `received`
 * entry (already `confirmed` — the coin was already on-chain by the time a scan observed it, so
 * there is no pending phase to track) for every asset whose held amount increased. A decrease
 * (spent) or unchanged balance emits nothing — spends are logged at the moment the extension
 * performs them (`appendActivityEntry`), never reconstructed here.
 *
 * `prev` may be `null`/`undefined` (no prior baseline, e.g. right after a wallet/index switch
 * cleared `walletCache.balances`) — the caller decides whether that should suppress detection
 * entirely (recommended: skip the very first scan after a switch, so a wallet's pre-existing
 * balance is never misreported as a fresh "receive"); this function itself treats a missing prior
 * amount as a `0` baseline, which is exactly a "skip" when the caller doesn't invoke it without a
 * real prior snapshot.
 */
export function detectReceivedEntries(prev: BalanceSnapshot | null | undefined, next: BalanceSnapshot, now: number): LocalActivityEntry[] {
  const out: LocalActivityEntry[] = [];
  const prevXch = prev?.xch ?? 0;
  const nextXch = next?.xch ?? 0;
  if (nextXch > prevXch) out.push(receivedEntry('XCH', nextXch - prevXch, now));

  const prevCats = prev?.cats ?? {};
  const nextCats = next?.cats ?? {};
  for (const [assetId, amount] of Object.entries(nextCats)) {
    const before = prevCats[assetId] ?? 0;
    if (amount > before) out.push(receivedEntry(assetId, amount - before, now));
  }
  return out;
}

let receivedSeq = 0;
/** Build one `received` entry for a positive balance delta. `id` folds in a monotonic counter so
 * two assets crossing in the SAME millisecond never collide as duplicate React keys. */
function receivedEntry(asset: string, delta: number, now: number): LocalActivityEntry {
  return {
    id: `received:${asset}:${now}:${receivedSeq++}`,
    kind: 'received',
    asset,
    amount: String(delta),
    counterparty: null,
    coinId: null,
    timestamp: now,
    status: 'confirmed',
  };
}
