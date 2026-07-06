import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { AssetRow } from '@/components/AssetRow';
import { ReceiveView } from '@/features/wallet/ReceiveView';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setWalletView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { useGetCustodyBalancesQuery, useGetReceiveAddressQuery } from '@/features/wallet/custodyApi';
import { useGetPricesQuery } from '@/features/wallet/priceApi';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { ManageTokens } from '@/features/wallet/custody/ManageTokens';
import { pickHeroBalance, balancesAreEmpty } from '@/features/wallet/portfolio';
import { PortfolioHero } from '@/features/wallet/PortfolioHero';
import { assetUsdValue, portfolioValue } from '@/features/wallet/portfolioValue';
import { PrivacyNote } from '@/features/wallet/custody/PrivacyNote';
import { ChainNodeSetting } from '@/features/wallet/custody/ChainNodeSetting';
import { ConnectedSites } from '@/features/wallet/custody/ConnectedSites';
import { SendPanel } from '@/features/wallet/custody/SendPanel';
import { TradePanel } from '@/features/wallet/custody/TradePanel';
import { ContactsManager } from '@/features/contacts/ContactsManager';
import { CustodyActivity } from '@/features/wallet/custody/CustodyActivity';
import { CollectiblesPanel } from '@/features/collectibles/CollectiblesPanel';
import { useState } from 'react';
import type { WalletView } from '@/app/tabs';

const SEG_OPTIONS: { value: WalletView; labelId: string }[] = [
  { value: 'home', labelId: 'wallet.view.home' },
  { value: 'activity', labelId: 'wallet.view.activity' },
  { value: 'trade', labelId: 'wallet.view.trade' },
  { value: 'collectibles', labelId: 'wallet.view.collectibles' },
];

/**
 * The self-custody wallet body (§18) — the read-only Balances & Intents surface backed by the
 * offscreen HD scan (XCH + watched CATs, both schemes, via coinset). Send/Trade/Activity are wired
 * once local signing lands (a follow-up); here Home shows balances + Receive, with the one-time
 * privacy note and the advanced chain-node override. Four states drive the assets query.
 */
export function CustodyWallet() {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const walletView = useAppSelector((s) => s.ui.walletView);
  const advanced = useAppSelector((s) => s.ui.advanced);
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const [hiddenCats] = useStorageValue<unknown>('wallet.hiddenCats', []);
  const balances = useGetCustodyBalancesQuery();
  const receive = useGetReceiveAddressQuery();
  const prices = useGetPricesQuery();
  const registry = useGetCatRegistryQuery();

  const assets = custodyAssetBalances(balances.data?.balances, watchedCats, { registry: registry.data, hidden: hiddenCats });
  const hero = pickHeroBalance(assets);
  const priceMap = prices.data ?? {};
  const total = portfolioValue(assets, priceMap);
  const cached = balances.data?.cached === true;
  const [homePanel, setHomePanel] = useState<'assets' | 'send' | 'contacts' | 'tokens'>('assets');

  /** Format a row's fiat value as `≈ $x.xx`, or null when it can't be priced. */
  const fiatLabelFor = (row: (typeof assets)[number]): string | null => {
    const usd = assetUsdValue(row, priceMap);
    return usd == null ? null : `≈ ${intl.formatNumber(usd, { style: 'currency', currency: 'USD' })}`;
  };

  return (
    <div data-testid="custody-wallet">
      <PrivacyNote />

      <section className="dig-card" aria-labelledby="custody-portfolio-title">
        <p className="dig-muted" id="custody-portfolio-title" style={{ marginTop: 0 }}>
          <FormattedMessage id="wallet.portfolio.total" />
        </p>
        <PortfolioHero
          total={total}
          hero={hero}
          pricesLoading={prices.isLoading}
          pricesError={prices.isError}
          onRetry={() => void prices.refetch()}
        />
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

      {walletView === 'home' && homePanel === 'send' && (
        <SendPanel assets={assets} onClose={() => setHomePanel('assets')} onManageContacts={() => setHomePanel('contacts')} />
      )}

      {walletView === 'home' && homePanel === 'contacts' && (
        <ContactsManager onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'tokens' && (
        <ManageTokens assets={assets} onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'assets' && (
        <>
          <div className="dig-action-bar" style={{ display: 'flex', gap: 8, margin: '4px 0 14px' }}>
            <button type="button" className="dig-btn dig-btn--primary" data-testid="action-send" onClick={() => setHomePanel('send')}>
              <FormattedMessage id="wallet.action.send" />
            </button>
            <button type="button" className="dig-btn" data-testid="action-contacts" onClick={() => setHomePanel('contacts')}>
              <FormattedMessage id="wallet.action.contacts" />
            </button>
          </div>
          <div className="dig-toggle-row">
            <h2 className="dig-heading" style={{ margin: 0 }}>
              <FormattedMessage id="wallet.assets.title" />
            </h2>
            <button type="button" className="dig-link" data-testid="action-manage-tokens" onClick={() => setHomePanel('tokens')}>
              <FormattedMessage id="tokens.manage.open" />
            </button>
          </div>
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
                  fiatLabel={fiatLabelFor(a)}
                  iconUrl={a.descriptor.iconUrl}
                  priceLoading={prices.isLoading}
                  testid={`asset-${a.descriptor.key}`}
                />
              ))}
            </div>
          </FourState>

          <h2 className="dig-heading" style={{ marginTop: 18 }}>
            <FormattedMessage id="receive.title" />
          </h2>
          <ReceiveView address={receive.data?.address} />

          {advanced && (
            <>
              <ChainNodeSetting />
              <ConnectedSites />
            </>
          )}
        </>
      )}

      {walletView === 'activity' && <CustodyActivity />}
      {walletView === 'trade' && <TradePanel assets={assets} />}
      {walletView === 'collectibles' && <CollectiblesPanel />}
    </div>
  );
}
