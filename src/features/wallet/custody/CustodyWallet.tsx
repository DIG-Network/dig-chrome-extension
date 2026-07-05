import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { AssetRow } from '@/components/AssetRow';
import { ReceiveView } from '@/features/wallet/ReceiveView';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setWalletView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { useGetCustodyBalancesQuery, useGetReceiveAddressQuery } from '@/features/wallet/custodyApi';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { pickHeroBalance, balancesAreEmpty } from '@/features/wallet/portfolio';
import { PrivacyNote } from '@/features/wallet/custody/PrivacyNote';
import { ChainNodeSetting } from '@/features/wallet/custody/ChainNodeSetting';
import type { WalletView } from '@/app/tabs';

const SEG_OPTIONS: { value: WalletView; labelId: string }[] = [
  { value: 'home', labelId: 'wallet.view.home' },
  { value: 'activity', labelId: 'wallet.view.activity' },
  { value: 'trade', labelId: 'wallet.view.trade' },
];

/**
 * The self-custody wallet body (§18) — the read-only Balances & Intents surface backed by the
 * offscreen HD scan (XCH + watched CATs, both schemes, via coinset). Send/Trade/Activity are wired
 * once local signing lands (a follow-up); here Home shows balances + Receive, with the one-time
 * privacy note and the advanced chain-node override. Four states drive the assets query.
 */
export function CustodyWallet() {
  const dispatch = useAppDispatch();
  const walletView = useAppSelector((s) => s.ui.walletView);
  const advanced = useAppSelector((s) => s.ui.advanced);
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const balances = useGetCustodyBalancesQuery();
  const receive = useGetReceiveAddressQuery();

  const assets = custodyAssetBalances(balances.data?.balances, watchedCats);
  const hero = pickHeroBalance(assets);
  const cached = balances.data?.cached === true;

  return (
    <div data-testid="custody-wallet">
      <PrivacyNote />

      <section className="dig-card" aria-labelledby="custody-portfolio-title">
        <p className="dig-muted" id="custody-portfolio-title" style={{ marginTop: 0 }}>
          <FormattedMessage id="wallet.portfolio.total" />
        </p>
        <p className="dig-portfolio-value" data-testid="portfolio-value" style={{ margin: '2px 0 0' }}>
          {hero.amountLabel} <span className="dig-muted">{hero.ticker}</span>
        </p>
        {cached && (
          <p className="dig-muted" role="status" data-testid="balances-cached" style={{ marginBottom: 0 }}>
            <FormattedMessage id="custody.balances.cached" />
          </p>
        )}
      </section>

      <div className="dig-toggle-row" style={{ margin: '14px 0' }}>
        <SegmentedControl<WalletView>
          value={walletView}
          options={SEG_OPTIONS}
          onChange={(v) => dispatch(setWalletView(v))}
          ariaLabel="Wallet views"
          idPrefix="wallet"
        />
      </div>

      {walletView === 'home' && (
        <>
          <h2 className="dig-heading">
            <FormattedMessage id="wallet.assets.title" />
          </h2>
          <FourState
            isLoading={balances.isLoading}
            isError={balances.isError}
            isEmpty={!balances.isLoading && !balances.isError && balancesAreEmpty(assets)}
            onRetry={() => void balances.refetch()}
            testid="custody-balances"
            emptyId="wallet.assets.empty"
            errorId="wallet.assets.error"
          >
            <div data-testid="custody-assets">
              {assets.map((a) => (
                <AssetRow
                  key={a.descriptor.key + (a.descriptor.assetId ?? '')}
                  ticker={a.descriptor.ticker}
                  name={a.descriptor.name}
                  amountLabel={a.label}
                  fiatLabel={null}
                  testid={`asset-${a.descriptor.key}`}
                />
              ))}
            </div>
          </FourState>

          <h2 className="dig-heading" style={{ marginTop: 18 }}>
            <FormattedMessage id="receive.title" />
          </h2>
          <ReceiveView address={receive.data?.address} />

          {advanced && <ChainNodeSetting />}
        </>
      )}

      {walletView === 'activity' && (
        <div className="dig-state" data-state="empty" data-testid="custody-activity-soon">
          <FormattedMessage id="custody.soon.activity" />
        </div>
      )}
      {walletView === 'trade' && (
        <div className="dig-state" data-state="empty" data-testid="custody-trade-soon">
          <FormattedMessage id="custody.soon.trade" />
        </div>
      )}
    </div>
  );
}
