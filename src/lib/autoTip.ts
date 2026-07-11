// Auto-tip configuration — the pure model behind the extension's creator-tipping preference (#379,
// child of #377). $DIG North Star (§6.0): tipping is opt-in, one-tap, dismissible, and honest.
//
// SPLIT OF RESPONSIBILITY: the extension PERSISTS the policy (this module + `AutoTipSetting`); the
// UNATTENDED EXECUTION (watching for DIG loads, resolving the creator, spending $DIG within the caps)
// is the dig-node tipping subsystem's job (#377/#369 WS), NOT yet built. So this module carries the
// config shape + validation + amount resolution; it deliberately does NOT schedule tips — that
// scheduling lives in the node once it ships.
//
// Persistence: a single `chrome.storage.local` key holding the whole config blob (the `useStorageValue`
// single-key idiom, matching `toolbar.ts`). Pure — no chrome.*/DOM — so it unit-tests DOM-free.

/** The single storage key holding the auto-tip config blob. */
export const AUTOTIP_CONFIG_KEY = 'autotip.config';

/**
 * How often an enabled auto-tip fires (the policy the node executes):
 * - `per-site-per-day` — at most one tip per site (store) per calendar day;
 * - `per-day-period` — a single daily $DIG budget spread across ALL sites.
 */
export type AutoTipMode = 'per-site-per-day' | 'per-day-period';

/** Every supported mode, in display order (first is the default). */
export const AUTOTIP_MODES: readonly AutoTipMode[] = ['per-site-per-day', 'per-day-period'] as const;

/** The persisted auto-tip preference. */
export interface AutoTipConfig {
  /** Master switch — when true, unattended tipping is authorized (executed by the node, #377). */
  enabled: boolean;
  /** Default $DIG amount per tip, as a display decimal string (e.g. `"1"`, `"0.5"`). */
  amountDig: string;
  /** Frequency/budget policy. */
  mode: AutoTipMode;
  /** Optional per-store amount overrides (storeId → $DIG decimal string). */
  perSiteOverrides: Record<string, string>;
}

export const DEFAULT_AUTOTIP_AMOUNT_DIG = '1';
export const DEFAULT_AUTOTIP_MODE: AutoTipMode = 'per-site-per-day';

/** The default config — OFF, so tipping is strictly opt-in (§6.0). */
export const DEFAULT_AUTOTIP_CONFIG: AutoTipConfig = {
  enabled: false,
  amountDig: DEFAULT_AUTOTIP_AMOUNT_DIG,
  mode: DEFAULT_AUTOTIP_MODE,
  perSiteOverrides: {},
};

/** Type guard: is `v` a supported auto-tip mode? */
export function isAutoTipMode(v: unknown): v is AutoTipMode {
  return typeof v === 'string' && (AUTOTIP_MODES as readonly string[]).includes(v);
}

/**
 * Is `amountDig` a positive, finite decimal string (a spendable $DIG amount)? Rejects `""`, `"0"`,
 * negatives, and non-numeric text — an auto-tip / manual tip must never fire a zero or garbage amount.
 */
export function isValidTipAmount(amountDig: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(amountDig.trim())) return false;
  const n = Number(amountDig);
  return Number.isFinite(n) && n > 0;
}

/**
 * Coerce a raw/persisted value into a valid {@link AutoTipConfig}. Storage can hold anything (an old
 * shape, a hand-edited blob, `undefined`), so every field is defended: a bad amount/mode falls back to
 * its default, and `perSiteOverrides` keeps only string→valid-amount entries.
 */
export function normalizeAutoTipConfig(raw: unknown): AutoTipConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutoTipConfig>;
  const amountDig = typeof o.amountDig === 'string' && isValidTipAmount(o.amountDig) ? o.amountDig : DEFAULT_AUTOTIP_AMOUNT_DIG;
  const mode = isAutoTipMode(o.mode) ? o.mode : DEFAULT_AUTOTIP_MODE;
  const overrides: Record<string, string> = {};
  if (o.perSiteOverrides && typeof o.perSiteOverrides === 'object') {
    for (const [storeId, amount] of Object.entries(o.perSiteOverrides)) {
      if (typeof amount === 'string' && isValidTipAmount(amount)) overrides[storeId] = amount;
    }
  }
  return { enabled: o.enabled === true, amountDig, mode, perSiteOverrides: overrides };
}

/**
 * Auto-tip is "configured" — and the home-tab manual prompt hides (#379) — exactly when it is
 * enabled. (A disabled config is still persisted, but the manual one-tap widget stays visible.)
 */
export function isAutoTipConfigured(cfg: AutoTipConfig): boolean {
  return cfg.enabled === true;
}

/**
 * The $DIG amount to tip for a given store: its per-site override when present + valid, otherwise the
 * config's default amount. Never returns an invalid amount (falls back to the default).
 */
export function resolveTipAmount(cfg: AutoTipConfig, storeId: string): string {
  const override = cfg.perSiteOverrides[storeId];
  if (typeof override === 'string' && isValidTipAmount(override)) return override;
  return isValidTipAmount(cfg.amountDig) ? cfg.amountDig : DEFAULT_AUTOTIP_AMOUNT_DIG;
}
