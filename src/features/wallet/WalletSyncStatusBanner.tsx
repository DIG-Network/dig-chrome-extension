import { FormattedMessage } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import { useGetWalletSyncStatusQuery } from '@/features/wallet/walletSyncApi';
import { walletSyncView } from '@/features/wallet/walletSyncView';

/**
 * First-class wallet SYNCING / DISCONNECTED banner (#373), driven by the node's `sync_status` pushed
 * over the `/ws` transport (#372). Prominent by design: while the node's wallet is catching up it
 * shows "Syncing… (peak/target)" with a progress bar and warns that balances/spends aren't final;
 * when the socket is down it shows a clear DISCONNECTED alert and labels any still-visible content as
 * cached/offline. When synced it renders NOTHING (the wallet is normal). A live region announces the
 * state to a screen reader (polite for syncing, assertive `alert` for disconnected).
 */
export function WalletSyncStatusBanner() {
  const { data } = useGetWalletSyncStatusQuery();
  const view = walletSyncView(data);
  if (!view.showBanner) return null;

  const isSyncing = view.state === 'syncing';
  const cls = isSyncing ? 'dig-banner dig-banner--warn' : 'dig-banner dig-banner--danger';

  return (
    <div
      className={`${cls} dig-sync-banner`}
      role={view.role}
      aria-live={view.role === 'alert' ? 'assertive' : 'polite'}
      data-testid="wallet-sync-banner"
      data-state={view.state}
    >
      <div className="dig-sync-banner__head">
        <StatusPill tone={view.tone} testid="wallet-sync-banner-pill">
          <FormattedMessage id={view.labelId} />
        </StatusPill>
        <strong className="dig-sync-banner__title">
          <FormattedMessage id={view.titleId} />
        </strong>
      </div>
      <p className="dig-sync-banner__detail" data-testid="wallet-sync-banner-detail">
        <FormattedMessage id={view.detailId} values={{ peak: view.values.peak, target: view.values.target }} />
      </p>
      {isSyncing && (
        <div
          className="dig-sync-progress"
          role="progressbar"
          data-testid="wallet-sync-progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(view.percent != null ? { 'aria-valuenow': view.percent } : { 'aria-valuetext': 'syncing' })}
        >
          <span
            className={`dig-sync-progress__bar${view.percent == null ? ' dig-sync-progress__bar--indeterminate' : ''}`}
            style={view.percent != null ? { width: `${view.percent}%` } : undefined}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Compact wallet-sync indicator for the header/toolbar (#373): a single pill reflecting
 * syncing / synced / disconnected. Always renders (unlike the banner) so the header carries a
 * persistent at-a-glance signal. Hidden from the a11y tree only when it would duplicate the banner
 * is NOT done — both are announced, the pill is a label, the banner is the live region.
 */
export function WalletSyncPill() {
  const { data } = useGetWalletSyncStatusQuery();
  const view = walletSyncView(data);
  return (
    <StatusPill tone={view.tone} testid="header-wallet-sync-pill">
      <FormattedMessage id={view.labelId} />
    </StatusPill>
  );
}
