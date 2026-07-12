/**
 * Tipping model (#380, child of #377) — the PURE, DOM-free, chrome-free client model behind the
 * fullscreen Tip tab. It mirrors the dig-node tipping subsystem's WS contract (dig-node SPEC §18.23,
 * shipped v0.21.0): the `TippingConfig` the extension reads/writes via `tip.get_config`/`tip.set_config`,
 * the tip-ledger entries it renders from `tip.get_ledger` + the pushed `{type:"tip"}` frame, and the
 * `TipOutcome` a `tip.manual` returns. The node OWNS execution (holds keys, builds+signs+broadcasts the
 * $DIG spend); the extension only CONFIGURES + DISPLAYS — so this module carries shapes, $DIG base-unit
 * conversions, normalization (defend every field of a node-supplied blob), timeframe filtering, and
 * aggregation, and deliberately never moves money.
 *
 * $DIG amounts are integer BASE UNITS on the wire (1 $DIG = 1000 base units, `DIG_DECIMALS = 3`), so
 * every display/parse goes through {@link baseUnitsToDigString}/{@link digStringToBaseUnits} — integer
 * math only, never float drift, never scientific notation.
 */

/** Base units per whole $DIG (dig-node SPEC §18.23: `DIG_DECIMALS = 3`). */
export const DIG_BASE_UNITS_PER_DIG = 1000;
/** $DIG on-wire decimal precision. */
export const DIG_DECIMALS = 3;

/**
 * The auto-tip frequency/budget policy (dig-node SPEC §18.23 `mode`):
 * - `per-site-per-day` — at most one tip per site (store) per UTC day, bounded by `per_site_cap`;
 * - `daily-budget` — a single daily $DIG budget spread across ALL sites.
 * NOTE these are the NODE canonical tokens; the older ext-local `per-day-period` (#379) is NOT one.
 */
export type TipMode = 'per-site-per-day' | 'daily-budget';
/** Every supported mode, in display order (first is the default). */
export const TIP_MODES: readonly TipMode[] = ['per-site-per-day', 'daily-budget'] as const;
/** Type guard: is `v` a node-canonical tip mode? */
export function isTipMode(v: unknown): v is TipMode {
  return typeof v === 'string' && (TIP_MODES as readonly string[]).includes(v);
}

/** One auto-tip policy (creator OR dev), base units for every amount. */
export interface AutoTipPolicy {
  /** Master switch — when true the node may tip unattended within the caps. */
  enabled: boolean;
  /** Default tip amount, $DIG base units. */
  dig_amount: number;
  /** Frequency/budget policy. */
  mode: TipMode;
  /** Per-site/day cap, $DIG base units (`per-site-per-day` mode). */
  per_site_cap: number;
  /** Optional per-store amount overrides (storeId → $DIG base units). */
  per_site_overrides: Record<string, number>;
}

/** The full node tipping config (`tip.get_config`/`tip.set_config`). */
export interface TippingConfig {
  /** Auto-tip policy for the content CREATOR (the on-chain-resolved store owner). */
  creator: AutoTipPolicy;
  /** Auto-tip policy for the DIG dev account (the treasury shared contract). */
  dev: AutoTipPolicy;
  /** Daily total cap spanning creator + dev, $DIG base units. */
  daily_total_cap: number;
  /** Network fee reserved per tip spend (opaque here; preserved round-trip). */
  fee: number;
}

/** Whether a ledger entry was an unattended auto tip or an explicit one-tap manual tip. */
export type TipTrigger = 'auto' | 'manual';
/** Whether a tip paid the content creator or the DIG dev account. */
export type TipKind = 'creator' | 'dev';
/** The tip's on-chain lifecycle status. */
export type TipStatus = 'pending' | 'confirmed' | 'failed';

/** One tip-ledger entry (dig-node SPEC §18.23 `tip.get_ledger` / the pushed `{type:"tip"}` frame). */
export interface TipLedgerEntry {
  /** Stable ledger id. */
  id: string;
  /** Recipient puzzle hash (the resolved owner / the treasury inner PH). */
  recipient_ph: string;
  /** The store that triggered the tip, when applicable. */
  store_id?: string;
  /** Amount, $DIG base units. */
  dig_amount: number;
  /** Timestamp — unix seconds OR ms (see {@link tipEntryMillis}). */
  ts: number;
  /** The UTC day the tip counts against (idempotency key component). */
  day?: string;
  /** Broadcast transaction id, once known. */
  txid?: string;
  trigger: TipTrigger;
  kind: TipKind;
  status: TipStatus;
}

/**
 * The result of a `tip.manual`/`tip.notify_consumed`/`tip.dev_tick` op (dig-node SPEC §18.23). A tip
 * that actually broadcast is `{ result:'tipped', txid, ... }`; anything not sent is `{ result:'skipped',
 * reason }` with a stable reason token (`disabled`, `owner-unresolved`, `already-tipped-today`,
 * `over-per-site-cap`, `over-daily-cap`, `state-unreadable: …`, `wallet-unavailable: …`,
 * `spend-failed-not-retried: …`). Until the node's live broadcaster lands (#428) a manual tip returns
 * `skipped` — the UI renders that honestly, never as a failure.
 */
export interface TipOutcome {
  result: 'tipped' | 'skipped';
  txid?: string;
  dig_amount?: number;
  recipient_ph?: string;
  reason?: string;
}

/** The history timeframes the Tip tab offers, in display order. */
export type TipTimeframe = 'today' | '7d' | '30d' | 'all';
export const TIP_TIMEFRAMES: readonly TipTimeframe[] = ['today', '7d', '30d', 'all'] as const;

// ── $DIG base-unit conversions (integer math only) ─────────────────────────────────────────────

/** Coerce a value to a non-negative integer (finite number or digit string), else 0. */
function toNonNegInt(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return 0;
}

/**
 * Render integer $DIG base units as a display decimal string — whole part + up to 3 fractional
 * digits, trailing zeros trimmed (`1000` → `"1"`, `1250` → `"1.25"`, `1` → `"0.001"`). Never float
 * drift, never scientific notation. Garbage / negative → `"0"`.
 */
export function baseUnitsToDigString(base: number): string {
  if (!Number.isFinite(base) || base < 0) return '0';
  const b = Math.floor(base);
  const whole = Math.floor(b / DIG_BASE_UNITS_PER_DIG);
  const frac = b % DIG_BASE_UNITS_PER_DIG;
  if (frac === 0) return String(whole);
  const fracStr = String(frac).padStart(DIG_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Parse a display $DIG decimal string to integer base units. Accepts a non-negative decimal with at
 * most {@link DIG_DECIMALS} fractional digits (`"1"`, `"0.5"`, `"0.001"`); returns null for anything
 * malformed, negative, or finer than $DIG precision — a tip must never be built from a bad amount.
 */
export function digStringToBaseUnits(s: string): number | null {
  const t = String(s ?? '').trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const fracStr = (m[2] ?? '').padEnd(DIG_DECIMALS, '0');
  return whole * DIG_BASE_UNITS_PER_DIG + parseInt(fracStr || '0', 10);
}

/** Is `s` a positive, ≤3-decimal $DIG amount (a spendable tip amount)? */
export function isValidTipAmountDig(s: string): boolean {
  const base = digStringToBaseUnits(s);
  return base != null && base > 0;
}

// ── defaults + normalization ───────────────────────────────────────────────────────────────────

/** A safe, OFF auto-tip policy (used to fill a missing side of a node-supplied config for display). */
export const DEFAULT_AUTOTIP_POLICY: AutoTipPolicy = {
  enabled: false,
  dig_amount: 0,
  mode: 'per-site-per-day',
  per_site_cap: 0,
  per_site_overrides: {},
};

/** A safe, OFF tipping config. */
export const DEFAULT_TIPPING_CONFIG: TippingConfig = {
  creator: { ...DEFAULT_AUTOTIP_POLICY, per_site_overrides: {} },
  dev: { ...DEFAULT_AUTOTIP_POLICY, per_site_overrides: {} },
  daily_total_cap: 0,
  fee: 0,
};

/**
 * Coerce a raw/node-supplied value into a valid {@link AutoTipPolicy}. Every field is defended (a bad
 * amount/mode falls back to its default; `per_site_overrides` keeps only string→non-negative-int
 * entries) so a partial or hand-edited blob can never desync the controls.
 */
export function normalizeAutoTipPolicy(raw: unknown): AutoTipPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutoTipPolicy>;
  const overrides: Record<string, number> = {};
  if (o.per_site_overrides && typeof o.per_site_overrides === 'object') {
    for (const [storeId, amount] of Object.entries(o.per_site_overrides as Record<string, unknown>)) {
      const n = toNonNegInt(amount);
      // A well-formed positive override is kept; a 0/negative/garbage value is dropped (no override).
      if (n > 0) overrides[storeId] = n;
    }
  }
  return {
    enabled: o.enabled === true,
    dig_amount: toNonNegInt(o.dig_amount),
    mode: isTipMode(o.mode) ? o.mode : 'per-site-per-day',
    per_site_cap: toNonNegInt(o.per_site_cap),
    per_site_overrides: overrides,
  };
}

/** Coerce a raw/node-supplied value into a valid {@link TippingConfig} (both policies always present). */
export function normalizeTippingConfig(raw: unknown): TippingConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<TippingConfig>;
  return {
    creator: normalizeAutoTipPolicy(o.creator),
    dev: normalizeAutoTipPolicy(o.dev),
    daily_total_cap: toNonNegInt(o.daily_total_cap),
    fee: toNonNegInt(o.fee),
  };
}

/**
 * Coerce a raw ledger entry into a {@link TipLedgerEntry}, or null if it lacks the fields that make it
 * meaningful (a non-empty id + a parseable non-negative amount). Unknown enum values fall back to a
 * safe token (trigger→auto, kind→creator, status→pending) so a forward-incompatible entry still renders.
 */
export function normalizeLedgerEntry(raw: unknown): TipLedgerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  if (typeof o.dig_amount !== 'number' && !(typeof o.dig_amount === 'string' && /^\d+$/.test(o.dig_amount.trim()))) {
    return null;
  }
  const trigger: TipTrigger = o.trigger === 'manual' ? 'manual' : 'auto';
  const kind: TipKind = o.kind === 'dev' ? 'dev' : 'creator';
  const status: TipStatus = o.status === 'confirmed' || o.status === 'failed' ? o.status : 'pending';
  return {
    id,
    recipient_ph: typeof o.recipient_ph === 'string' ? o.recipient_ph : '',
    store_id: typeof o.store_id === 'string' && o.store_id ? o.store_id : undefined,
    dig_amount: toNonNegInt(o.dig_amount),
    ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0,
    day: typeof o.day === 'string' && o.day ? o.day : undefined,
    txid: typeof o.txid === 'string' && o.txid ? o.txid : undefined,
    trigger,
    kind,
    status,
  };
}

/** Map + filter a raw ledger array into valid {@link TipLedgerEntry}s (defends non-arrays → `[]`). */
export function normalizeLedger(raw: unknown): TipLedgerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TipLedgerEntry[] = [];
  for (const r of raw) {
    const e = normalizeLedgerEntry(r);
    if (e) out.push(e);
  }
  return out;
}

// ── timeframe filtering + aggregation ────────────────────────────────────────────────────────────

/** Below this, `ts` is unix SECONDS (×1000 to ms); at/above it is already ms. Valid for centuries. */
const SECONDS_MS_THRESHOLD = 1e12;

/** The entry's timestamp in ms, tolerating a node that emits unix seconds OR milliseconds. */
export function tipEntryMillis(entry: Pick<TipLedgerEntry, 'ts'>): number {
  const ts = entry.ts;
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < SECONDS_MS_THRESHOLD ? ts * 1000 : ts;
}

/** The minimum entry-ms to include for a timeframe, relative to `now` (ms). `all` → 0. */
export function timeframeCutoffMs(tf: TipTimeframe, now: number): number {
  switch (tf) {
    case 'today': {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
    }
    case '7d':
      return now - 7 * 86_400_000;
    case '30d':
      return now - 30 * 86_400_000;
    case 'all':
    default:
      return 0;
  }
}

/** The subset of `entries` whose timestamp falls within the timeframe window ending at `now`. */
export function filterLedgerByTimeframe(
  entries: TipLedgerEntry[],
  tf: TipTimeframe,
  now: number,
): TipLedgerEntry[] {
  const cutoff = timeframeCutoffMs(tf, now);
  return entries.filter((e) => tipEntryMillis(e) >= cutoff);
}

/** A rolled-up view of a ledger slice: how many tips + total $DIG base units. */
export interface TipSummary {
  count: number;
  totalBaseUnits: number;
}

/** Count + sum the base units across a ledger slice. */
export function summarizeLedger(entries: TipLedgerEntry[]): TipSummary {
  let totalBaseUnits = 0;
  for (const e of entries) totalBaseUnits += e.dig_amount;
  return { count: entries.length, totalBaseUnits };
}

// ── editable form model (base units ⇄ display strings for the manage UI) ─────────────────────────

/** One policy as EDITABLE form fields ($DIG amounts as display strings so typing never snaps back). */
export interface TipPolicyForm {
  enabled: boolean;
  /** Default tip amount as a display $DIG string. */
  amount: string;
  mode: TipMode;
  /** Per-site/day cap as a display $DIG string. */
  perSiteCap: string;
  /** Per-store overrides (storeId → base units), edited via add/remove (not free text). */
  perSiteOverrides: Record<string, number>;
}

/** The whole config as editable form fields. `fee` is preserved as-is (not surfaced for edit). */
export interface TipConfigForm {
  creator: TipPolicyForm;
  dev: TipPolicyForm;
  /** Daily total cap as a display $DIG string. */
  dailyCap: string;
  /** Network fee (base units) — preserved round-trip, not user-edited. */
  fee: number;
}

/** Seed an editable {@link TipPolicyForm} from a normalized {@link AutoTipPolicy}. */
export function policyToForm(p: AutoTipPolicy): TipPolicyForm {
  return {
    enabled: p.enabled,
    amount: baseUnitsToDigString(p.dig_amount),
    mode: p.mode,
    perSiteCap: baseUnitsToDigString(p.per_site_cap),
    perSiteOverrides: { ...p.per_site_overrides },
  };
}

/** Seed an editable {@link TipConfigForm} from a {@link TippingConfig}. */
export function tipConfigToForm(c: TippingConfig): TipConfigForm {
  return {
    creator: policyToForm(c.creator),
    dev: policyToForm(c.dev),
    dailyCap: baseUnitsToDigString(c.daily_total_cap),
    fee: c.fee,
  };
}

/** Is `s` a parseable amount FIELD (a non-negative ≤3-decimal $DIG string — caps may be 0)? */
export function isAmountField(s: string): boolean {
  return digStringToBaseUnits(s) != null;
}

/** Convert an editable policy form back to a policy, or null if any amount field is malformed. */
export function formToPolicy(f: TipPolicyForm): AutoTipPolicy | null {
  const dig_amount = digStringToBaseUnits(f.amount);
  const per_site_cap = digStringToBaseUnits(f.perSiteCap);
  if (dig_amount == null || per_site_cap == null) return null;
  return { enabled: f.enabled, dig_amount, mode: f.mode, per_site_cap, per_site_overrides: { ...f.perSiteOverrides } };
}

/** Convert the editable config form back to a {@link TippingConfig}, or null if any field is malformed. */
export function tipFormToConfig(f: TipConfigForm): TippingConfig | null {
  const creator = formToPolicy(f.creator);
  const dev = formToPolicy(f.dev);
  const daily_total_cap = digStringToBaseUnits(f.dailyCap);
  if (!creator || !dev || daily_total_cap == null) return null;
  return { creator, dev, daily_total_cap, fee: f.fee };
}

/** Is the whole config form valid (every amount field parses)? Gates the Save button. */
export function isTipFormValid(f: TipConfigForm): boolean {
  return tipFormToConfig(f) != null;
}
