import { FormattedMessage } from 'react-intl';
import { SegmentedControl } from '@/components/SegmentedControl';
import { FourState } from '@/components/FourState';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setWalletView } from '@/features/ui/uiSlice';
import { WALLET_VIEWS, type WalletView } from '@/app/tabs';
import { shortenAddress } from '#shared/wallet-view.mjs';
import { useGetConnectionQuery, useGetBalancesQuery, useDisconnectMutation } from '@/features/wallet/walletApi';
import { ConnectPanel } from '@/features/wallet/ConnectPanel';
import { Home } from '@/features/wallet/Home';
import { Activity } from '@/features/wallet/Activity';
import { Trade } from '@/features/wallet/Trade';

const SEG_OPTIONS = WALLET_VIEWS.map((v) => ({ value: v, labelId: `wallet.view.${v}` }));

/**
 * The Wallet tab — the Balances & Intents surface. Gates on the WalletConnect session: while it
 * resolves, four-state loading; when there's no session, the ConnectPanel; when connected, the
 * Home/Activity/Trade segmented control drives the active view, with a connected chip + disconnect.
 * The active sub-view is cross-document client state (`ui.walletView`).
 */
export function WalletTab() {
  const dispatch = useAppDispatch();
  const walletView = useAppSelector((s) => s.ui.walletView);
  const connection = useGetConnectionQuery();
  const balances = useGetBalancesQuery(undefined, { skip: !connection.data?.connected });
  const [disconnect] = useDisconnectMutation();

  const connected = connection.data?.connected === true;
  const address = connection.data?.address;
  const assets = balances.data ?? [];

  return (
    <div data-testid="wallet-panel">
      <FourState
        isLoading={connection.isLoading}
        isError={connection.isError}
        isEmpty={false}
        onRetry={() => void connection.refetch()}
        testid="wallet-connection"
      >
        {!connected ? (
          <ConnectPanel />
        ) : (
          <>
            <div className="dig-toggle-row" style={{ marginBottom: 14 }}>
              <SegmentedControl<WalletView>
                value={walletView}
                options={SEG_OPTIONS}
                onChange={(v) => dispatch(setWalletView(v))}
                ariaLabel="Wallet views"
                idPrefix="wallet"
              />
              <button type="button" className="dig-link" data-testid="wallet-disconnect" onClick={() => void disconnect()}>
                <FormattedMessage id="wallet.disconnect" />
              </button>
            </div>
            {address && (
              <p className="dig-muted" data-testid="wallet-connected-as" style={{ marginTop: 0 }}>
                <FormattedMessage id="wallet.connected.as" values={{ address: shortenAddress(address) }} />
              </p>
            )}
            <div
              role="tabpanel"
              id={`wallet-panel-${walletView}`}
              aria-labelledby={`wallet-tab-${walletView}`}
              tabIndex={0}
            >
              {walletView === 'home' && <Home address={address} onGoTrade={() => dispatch(setWalletView('trade'))} />}
              {walletView === 'activity' && <Activity />}
              {walletView === 'trade' && <Trade assets={assets} />}
            </div>
          </>
        )}
      </FourState>
    </div>
  );
}
