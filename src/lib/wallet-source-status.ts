/**
 * Wallet-data source indicator view-model (#222) — PURE mapping from a resolved wallet-data
 * source (`wallet-source.ts` `ResolvedWalletSource`) + the selected `ChainSourceMode` to the
 * tone + message id the `ChainSourceSetting` panel's "Local dig-node detected" indicator renders.
 * Mirrors `resolve-status.ts` / `dig-dns-status.ts`'s split: the resolution logic (background
 * probes) stays chrome-free and independently testable; this is the presentation mapping only.
 *
 * Scope (#222): the indicator surfaces specifically when **Auto** mode's §5.3 ladder auto-selected
 * a local node — the zero-config case the issue is about (no manual server-host/chainSourceUrl
 * needed). It intentionally stays quiet for the user-FORCED modes (node/custom/coinset) — those
 * already have their own mode-specific hint text (`custody.source.hint.*`) telling that story, and
 * showing "detected" there would be redundant with (or contradict, on a strict-unavailable read)
 * the four-state error UI those modes already surface on failure.
 */
import type { PillTone } from '@/components/StatusPill';
import type { ChainSourceMode, ResolvedWalletSource } from '@/lib/wallet-source';

/** The tone + react-intl message id (+ endpoint interpolation) the indicator renders, or hidden. */
export interface WalletSourceIndicatorView {
  visible: boolean;
  tone: PillTone;
  /** A react-intl message id; only meaningful when `visible`. */
  labelId: string;
  /** The detected node's base URL, interpolated into the `labelId` message as `{endpoint}`. */
  endpoint?: string;
}

const HIDDEN: WalletSourceIndicatorView = { visible: false, tone: 'neutral', labelId: '' };

/**
 * Map the current chain-source mode + its resolved source to the indicator view. Visible ONLY for
 * `mode === 'auto'` with a `resolved.kind === 'node'` result (a local node the §5.3 ladder found
 * with zero explicit configuration); hidden for every other mode/kind combination, and while the
 * resolution has not loaded yet (`resolved` undefined/null).
 */
export function walletSourceIndicatorView(
  mode: ChainSourceMode,
  resolved: ResolvedWalletSource | null | undefined,
): WalletSourceIndicatorView {
  if (!resolved) return HIDDEN;
  // #394 — the Sage backend shows its live connection status directly (which backend is active +
  // whether it is reachable), since Sage is a user-configured endpoint the user needs feedback on.
  if (mode === 'sage') {
    if (resolved.kind === 'node') {
      return { visible: true, tone: 'good', labelId: 'custody.source.sage.connected', endpoint: resolved.base };
    }
    if (resolved.kind === 'unavailable') {
      return { visible: true, tone: 'warn', labelId: 'custody.source.sage.unreachable' };
    }
    return HIDDEN;
  }
  // Auto mode: surface a zero-config local node the §5.3 ladder auto-selected. Other forced modes
  // stay quiet (their mode-specific hint + the four-state error UI already tell the story).
  if (mode !== 'auto' || resolved.kind !== 'node') return HIDDEN;
  return {
    visible: true,
    tone: 'good',
    labelId: 'custody.source.detected',
    endpoint: resolved.base,
  };
}
