import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { AssetRow } from '@/components/AssetRow';
import { ReceiveView } from '@/features/wallet/ReceiveView';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setWalletView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { useGetCustodyBalancesQuery, useGetReceiveAddressQuery, useGetClawbacksQuery, useListWalletsQuery } from '@/features/wallet/custodyApi';
import { useGetPricesQuery } from '@/features/wallet/priceApi';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { splitPinnedAssets } from '@/features/wallet/custody/assetOrder';
import { filterAssetsByQuery, assetAutocompleteSuggestions } from '@/features/wallet/custody/assetFilter';
import { AssetFilterField } from '@/features/wallet/custody/AssetFilterField';
import { ManageTokens } from '@/features/wallet/custody/ManageTokens';
import { pickHeroBalance, balancesAreEmpty } from '@/features/wallet/portfolio';
import { PortfolioHero } from '@/features/wallet/PortfolioHero';
import { assetUsdValue, portfolioValue } from '@/features/wallet/portfolioValue';
import { resolveFiatValue } from '@/features/wallet/fiatValue';
import { useFiatPreference } from '@/features/wallet/useFiatPreference';
import { GetDigMenu } from '@/features/wallet/GetDigMenu';
import { GetXchLink } from '@/features/wallet/GetXchLink';
import { FiatCurrencySetting } from '@/features/wallet/custody/FiatCurrencySetting';
import { PrivacyNote } from '@/features/wallet/custody/PrivacyNote';
import { WalletSwitcher } from '@/features/wallet/custody/WalletSwitcher';
import { AccountSwitcher } from '@/features/wallet/custody/AccountSwitcher';
import { ExportPrivateKey } from '@/features/wallet/custody/ExportPrivateKey';
import { ChainNodeSetting } from '@/features/wallet/custody/ChainNodeSetting';
import { ChainSourceSetting } from '@/features/wallet/custody/ChainSourceSetting';
import { AutoLockSetting } from '@/features/wallet/custody/AutoLockSetting';
import { AutoTipSetting } from '@/features/wallet/custody/AutoTipSetting';
import { SessionStatus } from '@/features/wallet/custody/SessionStatus';
import { NetworkSetting } from '@/features/wallet/custody/NetworkSetting';
import { ConnectedSites } from '@/features/wallet/custody/ConnectedSites';
import { DerivedAddressList } from '@/features/wallet/custody/DerivedAddressList';
import { SendPanel } from '@/features/wallet/custody/SendPanel';
import { CoinControlPanel } from '@/features/wallet/custody/CoinControlPanel';
import { ClawbackPanel } from '@/features/wallet/custody/ClawbackPanel';
import { TradePanel } from '@/features/wallet/custody/TradePanel';
import { ContactsManager } from '@/features/contacts/ContactsManager';
import { CustodyActivity } from '@/features/wallet/custody/CustodyActivity';
import { CollectiblesPanel } from '@/features/collectibles/CollectiblesPanel';
import { DidPanel } from '@/features/identity/DidPanel';
import { isFullpageSurface } from '@/features/collectibles/surface';
import { useMemo, useState } from 'react';
import { walletViewsForSurface, routeToHash, type WalletView } from '@/app/tabs';
import { popOutToFullpage } from '@/lib/popout';

const SEG_OPTIONS: { value: WalletView; labelId: string }[] = [
  { value: 'home', labelId: 'wallet.view.home' },
  { value: 'activity', labelId: 'wallet.view.activity' },
  { value: 'trade', labelId: 'wallet.view.trade' },
  { value: 'collectibles', labelId: 'wallet.view.collectibles' },
  { value: 'did', labelId: 'wallet.view.did' },
];

/**
 * The self-custody wallet body (§18) — the read-only Balances & Intents surface backed by the
 * offscreen HD scan (XCH + watched CATs, both schemes, via coinset). Send/Trade/Activity are wired
 * once local signing lands (a follow-up); here Home shows balances + Receive, with the one-time
 * privacy note and the advanced chain-node override. Four states drive the assets query.
 *
 * **Surface tiering (#163): the "Identity" segmented tab is fullscreen-only.** The compact popup's
 * SegmentedControl drops it ({@link walletViewsForSurface}) — Identity/DID management is ADVANCED
 * (§145), mirroring the create/transfer-form gating `DidPanel` already applies. `full` is
 * auto-detected from the surface (overridable in tests).
 */
export function CustodyWallet({ full }: { full?: boolean } = {}) {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const isFull = full ?? isFullpageSurface();
  const segOptions = useMemo(() => {
    const visible = walletViewsForSurface(isFull);
    return SEG_OPTIONS.filter((opt) => visible.includes(opt.value));
  }, [isFull]);
  const walletView = useAppSelector((s) => s.ui.walletView);
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const [hiddenCats] = useStorageValue<unknown>('wallet.hiddenCats', []);
  const balances = useGetCustodyBalancesQuery();
  const receive = useGetReceiveAddressQuery();
  const prices = useGetPricesQuery();
  const registry = useGetCatRegistryQuery();
  // #112 — the user's chosen display currency + its exchange-rate table (only fetched once a
  // non-USD currency is picked).
  const { fiat, setFiat, fx } = useFiatPreference();
  // #152 — pending clawbacks: the fullscreen-only management panel + the popup's "open full screen"
  // hint (rendered whenever at least one is pending, regardless of surface).
  const clawbacks = useGetClawbacksQuery();
  const pendingClawbackCount = clawbacks.data?.clawbacks?.length ?? 0;
  // #96 — is the active wallet watch-only? It can view balances but never send/sign, so the Send
  // action is disabled with an explanatory note and the private-key export is hidden entirely.
  const walletsList = useListWalletsQuery();
  const isWatchActive = walletsList.data?.wallets?.find((w) => w.active)?.kind === 'watch';

  const assets = custodyAssetBalances(balances.data?.balances, watchedCats, { registry: registry.data, hidden: hiddenCats });
  const hero = pickHeroBalance(assets);
  // Stable reference (not a fresh `?? {}` object every render) so it doesn't defeat the `useMemo`
  // below on every render even when the underlying price data hasn't changed.
  const priceMap = useMemo(() => prices.data ?? {}, [prices.data]);
  const total = portfolioValue(assets, priceMap);
  const cached = balances.data?.cached === true;
  const [homePanel, setHomePanel] = useState<'assets' | 'send' | 'receive' | 'contacts' | 'tokens' | 'coins' | 'clawback'>('assets');

  // #167 — value-ordered, live-filterable Assets list. #204: XCH + $DIG are PINNED in a fixed header
  // block ABOVE the filter input (via `splitPinnedAssets`) — the filter predicate never sees them,
  // so typing can neither hide nor reorder either. Only the remaining CATs (`tokenRows`) are ever
  // narrowed. Pure selectors do the work (`assetOrder`/`assetFilter`); this is just the memoized
  // wiring + the filter's own input state.
  const [assetFilter, setAssetFilter] = useState('');
  const { pinned: pinnedAssets, filterable: tokenRows } = useMemo(() => splitPinnedAssets(assets, priceMap), [assets, priceMap]);
  const visibleTokenRows = useMemo(() => filterAssetsByQuery(tokenRows, assetFilter), [tokenRows, assetFilter]);
  const filterSuggestions = useMemo(
    () => assetAutocompleteSuggestions(tokenRows, registry.data, assetFilter),
    [tokenRows, registry.data, assetFilter],
  );

  // The fx rate fetch is only "in flight" in a way that should gate a row's fiat display when the
  // user picked a non-USD currency — USD never needs it (#112/#158).
  const fxLoading = fiat !== 'usd' && fx.isLoading;

  /** A row's resolved fiat state in the chosen currency (#112), or null when it can't be priced at
   * all yet (no balance/USD price known — a separate, upstream concern from currency conversion). */
  const fiatStateFor = (row: (typeof assets)[number]) => {
    const usd = assetUsdValue(row, priceMap);
    return usd == null ? null : resolveFiatValue({ usd, fiat, fxRates: fx.data, fxLoading });
  };

  /** Render one Assets-list row (shared by the pinned XCH row and the sorted/filtered token rows). */
  const renderAssetRow = (a: (typeof assets)[number]) => {
    const fiatState = fiatStateFor(a);
    const fiatLabel =
      fiatState?.kind === 'value'
        ? `≈ ${intl.formatNumber(fiatState.amount, { style: 'currency', currency: fiatState.currency.toUpperCase() })}`
        : null;
    return (
      <AssetRow
        key={a.descriptor.key + (a.descriptor.assetId ?? '')}
        ticker={a.descriptor.ticker}
        name={a.descriptor.name}
        amountLabel={a.label}
        fiatLabel={fiatLabel}
        iconUrl={a.descriptor.iconUrl}
        priceLoading={prices.isLoading || fiatState?.kind === 'loading'}
        testid={a.descriptor.key === 'cat' ? `asset-cat-${a.descriptor.assetId}` : `asset-${a.descriptor.key}`}
        action={a.descriptor.key === 'dig' ? <GetDigMenu /> : a.descriptor.key === 'xch' ? <GetXchLink /> : undefined}
      />
    );
  };

  // #166 — Receive is a dedicated, full-replace screen (mirrors the NFT/DID-detail pattern): its
  // sticky ViewHeader + QR/address are the WHOLE body, with none of the shared wallet chrome above
  // it (switcher/portfolio/segmented tabs), so it's reachable with zero scrolling regardless of how
  // many CATs the wallet holds — the fix for "Receive buried below the CAT list".
  if (walletView === 'home' && homePanel === 'receive') {
    return (
      <div data-testid="custody-wallet">
        <ReceiveView address={receive.data?.address} onBack={() => setHomePanel('assets')} />
      </div>
    );
  }

  return (
    <div data-testid="custody-wallet">
      <div className="dig-toggle-row" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <WalletSwitcher />
        <AccountSwitcher />
      </div>
      <PrivacyNote />

      <section className="dig-card" aria-labelledby="custody-portfolio-title">
        <div className="dig-toggle-row" style={{ justifyContent: 'space-between', marginBottom: 0 }}>
          <p className="dig-muted" id="custody-portfolio-title" style={{ margin: 0 }}>
            <FormattedMessage id="wallet.portfolio.total" />
          </p>
          <FiatCurrencySetting value={fiat} onChange={setFiat} />
        </div>
        <PortfolioHero
          total={total}
          hero={hero}
          pricesLoading={prices.isLoading}
          pricesError={prices.isError}
          onRetry={() => void prices.refetch()}
          fiat={fiat}
          fxRates={fx.data}
          fxLoading={fxLoading}
        />
        {cached && (
          <p className="dig-muted" role="status" data-testid="balances-cached" style={{ marginBottom: 0 }}>
            <FormattedMessage id="custody.balances.cached" />
          </p>
        )}
      </section>

      {/* On the desktop workspace (#85) the persistent sidebar IS the wallet-view nav, so this
          in-content segmented control is redundant and hidden there via CSS (`.dig-shell-expanded`);
          it remains the primary nav on the compact popup + a narrow app.html. */}
      <div className="dig-toggle-row dig-wallet-seg-row" style={{ margin: '14px 0' }}>
        <SegmentedControl<WalletView>
          value={walletView}
          options={segOptions}
          onChange={(v) => dispatch(setWalletView(v))}
          ariaLabel="Wallet views"
          idPrefix="wallet"
        />
      </div>

      {walletView === 'home' && homePanel === 'send' && (
        <SendPanel assets={assets} onClose={() => setHomePanel('assets')} onManageContacts={() => setHomePanel('contacts')} full={isFull} />
      )}

      {walletView === 'home' && homePanel === 'contacts' && (
        <ContactsManager onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'tokens' && (
        <ManageTokens assets={assets} onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'coins' && (
        <CoinControlPanel assets={assets} onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'clawback' && (
        <ClawbackPanel onClose={() => setHomePanel('assets')} />
      )}

      {walletView === 'home' && homePanel === 'assets' && (
        <>
          <div className="dig-action-bar" style={{ display: 'flex', gap: 8, margin: '4px 0 14px' }}>
            <button
              type="button"
              className="dig-btn dig-btn--primary"
              data-testid="action-send"
              onClick={() => setHomePanel('send')}
              disabled={isWatchActive}
              title={isWatchActive ? intl.formatMessage({ id: 'watch.cannotSign' }) : undefined}
            >
              <FormattedMessage id="wallet.action.send" />
            </button>
            <button type="button" className="dig-btn" data-testid="action-receive" onClick={() => setHomePanel('receive')}>
              <FormattedMessage id="wallet.action.receive" />
            </button>
            <button type="button" className="dig-btn" data-testid="action-contacts" onClick={() => setHomePanel('contacts')}>
              <FormattedMessage id="wallet.action.contacts" />
            </button>
          </div>
          {isWatchActive && (
            <p className="dig-muted" role="note" data-testid="watch-only-note" style={{ margin: '0 0 12px' }}>
              <FormattedMessage id="watch.cannotSign" />
            </p>
          )}
          {/* Clawback (#152): fullscreen-only management link (§145); the popup shows a lighter
              "open full screen" hint instead when something is pending (below). */}
          {isFull && pendingClawbackCount > 0 && (
            <div style={{ margin: '0 0 12px' }}>
              <button type="button" className="dig-link" data-testid="action-clawback" onClick={() => setHomePanel('clawback')}>
                <FormattedMessage id="clawback.open" values={{ count: pendingClawbackCount }} />
              </button>
            </div>
          )}
          {!isFull && pendingClawbackCount > 0 && (
            <p className="dig-muted" data-testid="clawback-popup-hint" style={{ margin: '0 0 12px' }}>
              <FormattedMessage id="clawback.popupHint" values={{ count: pendingClawbackCount }} />{' '}
              <button
                type="button"
                className="dig-link"
                data-testid="clawback-popup-hint-open"
                onClick={() => void popOutToFullpage(routeToHash('wallet', walletView, undefined), true)}
              >
                <FormattedMessage id="shell.popout" />
              </button>
            </p>
          )}
          <div className="dig-toggle-row">
            <h2 className="dig-heading" style={{ margin: 0 }}>
              <FormattedMessage id="wallet.assets.title" />
            </h2>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" className="dig-link" data-testid="action-coins" onClick={() => setHomePanel('coins')}>
                <FormattedMessage id="coins.open" />
              </button>
              <button type="button" className="dig-link" data-testid="action-manage-tokens" onClick={() => setHomePanel('tokens')}>
                <FormattedMessage id="tokens.manage.open" />
              </button>
            </div>
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
              {pinnedAssets.map(renderAssetRow)}
              <AssetFilterField value={assetFilter} onChange={setAssetFilter} suggestions={filterSuggestions} testid="asset-filter" />
              {visibleTokenRows.length === 0 && assetFilter.trim() ? (
                <p className="dig-muted" data-testid="custody-assets-filter-empty">
                  <FormattedMessage id="wallet.assets.filter.empty" values={{ query: assetFilter.trim() }} />
                </p>
              ) : (
                visibleTokenRows.map(renderAssetRow)
              )}
            </div>
          </FourState>

          {/* Settings (§145): fullscreen-only, like every other advanced/power-user surface in this
              component (Identity tab, clawback management, …) — gated on the SURFACE (`isFull`),
              not a separate persisted "advanced" preference. A prior version gated this block on a
              `ui.advanced` flag that nothing ever set to true, making it unreachable on EITHER
              surface; see DEVELOPMENT_LOG.md. */}
          {isFull && (
            <>
              <NetworkSetting />
              <ChainSourceSetting />
              <ChainNodeSetting />
              <AutoLockSetting />
              <AutoTipSetting />
              <SessionStatus />
              <ConnectedSites />
              <DerivedAddressList />
              {/* Private-key export (#96, §18.20) — never for a watch-only wallet (it holds no
                  secret to export). */}
              {!isWatchActive && <ExportPrivateKey />}
            </>
          )}
        </>
      )}

      {walletView === 'activity' && <CustodyActivity />}
      {walletView === 'trade' && <TradePanel assets={assets} />}
      {walletView === 'collectibles' && <CollectiblesPanel />}
      {walletView === 'did' && <DidPanel />}
    </div>
  );
}
