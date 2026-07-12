import type { PillTone } from '@/components/StatusPill';
import type { WalletSyncStatus, WalletSyncState } from '@/lib/dig-node-wallet-ws';

/**
 * Pure view-model for the first-class wallet syncing/disconnected UI (#373). Maps the node's pushed
 * {@link WalletSyncStatus} (over the `/ws` transport, #372) into everything the header pill + the
 * wallet banner render — tone, message ids, a syncing progress percentage, and the ARIA live-region
 * role. DOM-free + react-intl-free so it is fully unit-testable; the components are thin
 * `<FormattedMessage>` renderers over this.
 *
 * The three states (dig-node SPEC §4.8):
 *   - `synced`       — normal wallet; no banner, a subtle "Synced" pill.
 *   - `syncing`      — the node's wallet is catching up; a PROMINENT banner + "Syncing (peak/target)",
 *                      warning that balances/spends are not yet final. A polite live region.
 *   - `disconnected` — the socket is down; the wallet is non-functional for live ops. A prominent
 *                      alert banner; cached read-only content may still show, labeled offline.
 */
export interface WalletSyncView {
  state: WalletSyncState;
  /** Pill/banner tone. */
  tone: PillTone;
  /** The compact pill label message id. */
  labelId: string;
  /** True when the prominent banner should render (any non-synced state). */
  showBanner: boolean;
  /** Banner title + detail message ids. */
  titleId: string;
  detailId: string;
  /** ICU interpolation values for the detail line (heights rendered as strings, `?` when unknown). */
  values: { peak: string; target: string };
  /** Sync progress 0–100 when both heights are known and syncing; null when indeterminate/not syncing. */
  percent: number | null;
  /** ARIA role for the banner's live region: syncing/synced are polite `status`, disconnected is an `alert`. */
  role: 'status' | 'alert';
  /** True when the UI must gate trust in balances/spends (not final): syncing OR disconnected. */
  balancesUntrusted: boolean;
}

function clampPercent(peak: number, target: number): number | null {
  if (target <= 0) return null;
  const pct = Math.round((peak / target) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Build the {@link WalletSyncView} for a wallet sync status (defaults to a disconnected view). */
export function walletSyncView(status: WalletSyncStatus | null | undefined): WalletSyncView {
  const state: WalletSyncState = status?.state ?? 'disconnected';
  const peak = status?.peakHeight ?? null;
  const target = status?.targetHeight ?? null;
  const values = { peak: peak != null ? String(peak) : '?', target: target != null ? String(target) : '?' };

  if (state === 'synced') {
    return {
      state,
      tone: 'good',
      labelId: 'wallet.sync.synced',
      showBanner: false,
      titleId: 'wallet.sync.synced.title',
      detailId: 'wallet.sync.synced.detail',
      values,
      percent: 100,
      role: 'status',
      balancesUntrusted: false,
    };
  }

  if (state === 'syncing') {
    return {
      state,
      tone: 'warn',
      labelId: 'wallet.sync.syncing',
      showBanner: true,
      titleId: 'wallet.sync.syncing.title',
      detailId: peak != null && target != null ? 'wallet.sync.syncing.detail' : 'wallet.sync.syncing.detail.indeterminate',
      values,
      percent: peak != null && target != null ? clampPercent(peak, target) : null,
      role: 'status',
      balancesUntrusted: true,
    };
  }

  return {
    state: 'disconnected',
    tone: 'bad',
    labelId: 'wallet.sync.disconnected',
    showBanner: true,
    titleId: 'wallet.sync.disconnected.title',
    detailId: 'wallet.sync.disconnected.detail',
    values,
    percent: null,
    role: 'alert',
    balancesUntrusted: true,
  };
}
