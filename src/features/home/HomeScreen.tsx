import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { setTab, setWalletView, setNetworkView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { FourState } from '@/components/FourState';
import { AppLauncherGrid, AppLauncherSkeleton } from '@/features/apps/AppLauncherGrid';
import { useGetStoreCatalogQuery } from '@/features/apps/appsApi';
import { useGetCustodyBalancesQuery, useGetLockStateQuery, useGetCustodyActivityQuery } from '@/features/wallet/custodyApi';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { useGetPricesQuery } from '@/features/wallet/priceApi';
import { useGetNodeStatusQuery } from '@/features/resolver/resolverApi';
import { OpenByUrnInput } from '@/features/home/OpenByUrnInput';
import { TipCreatorWidget } from '@/features/home/TipCreatorWidget';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { pickHeroBalance } from '@/features/wallet/portfolio';
import { assetUsdValue } from '@/features/wallet/portfolioValue';
import { resolveFiatValue } from '@/features/wallet/fiatValue';
import { useFiatPreference } from '@/features/wallet/useFiatPreference';
import { activityRows, type ActivityRow } from '@/features/wallet/custody/activityRows';
import {
  BALANCE_UNIT_STORAGE_KEY,
  DEFAULT_BALANCE_UNIT,
  isBalanceUnit,
  toggleBalanceUnit,
  heroBalanceDisplay,
  type BalanceUnit,
  type SlotDisplay,
} from '@/features/wallet/balanceUnit';

/** How many dApp icons the Home launcher widget shows before "see all". */
const HOME_LAUNCHER_LIMIT = 8;

/** Glyph per activity kind for the recent-activity peek (#154/#171 — mirrors `CustodyActivity.tsx`'s
 * `ICON`; all nine schema kinds so a future mint/DID/offer/clawback/melt entry never crashes). */
const KIND_GLYPH: Record<ActivityRow['kind'], string> = {
  sent: '↑',
  received: '⇩',
  trade: '⇄',
  mint: '✦',
  did: '◈',
  offer: '⇗',
  clawback: '↩',
  melt: '⟲',
  burn: '🔥',
};

/**
 * The mobile-OS Home screen (#65) — the launcher above the bottom nav. Arranged like a phone home:
 * a glanceable wallet-balance widget, quick-action tiles (Send / Receive / Trade), the native dApp
 * launcher grid, and status widgets (lock state, node/network status, a recent-activity peek). Every
 * widget deep-links into its full screen. Four states drive the launcher; the wallet widgets degrade
 * gracefully when the wallet is locked or absent. Responsive: one column on the phone popup, a
 * multi-column widget board on the wide tablet/desktop surface. The DIG toolbar enable/disable
 * switch moved OUT of here into the window header (#306, `HeaderToolbarToggle`).
 */
export function HomeScreen() {
  return (
    <div className="dig-home" data-testid="home-screen">
      {/* #312 — the URN entry input is the TOP-most Home element, docked flush to the top edge. */}
      <OpenByUrnInput />
      <div className="dig-home-board">
        {/* #379 — the tip-the-creator prompt self-hides unless a DIG resource is loaded on the active
            tab AND auto-tip is off, so it surfaces above the balance only when it's relevant. */}
        <TipCreatorWidget />
        <BalanceWidget />
        <QuickActions />
        <StatusWidget />
        <ActivityPeek />
      </div>
      <LauncherWidget />
    </div>
  );
}

/**
 * Glanceable portfolio value → tap opens the Wallet. Prompts to open/unlock when locked or absent.
 * A swap control beside the value flips which unit is PROMINENT — $ (USD) or XCH (#156) — with the
 * other shown small underneath; the choice persists to `chrome.storage.local` (same
 * `useStorageValue` idiom as the watched/hidden-CAT prefs already used on this screen) so it
 * survives popup reopen. The price-dependent slot renders one of three honest states — a shimmer
 * skeleton while the price fetch is in flight, the real value once it resolves, or a subtle
 * "price unavailable" note on genuine failure — NEVER a fabricated `$—`, and never "unavailable"
 * during the loading window (`heroBalanceDisplay` resolves which). The $ value renders in the
 * user's chosen fiat currency (#112, `useFiatPreference` — the SAME preference the wallet's
 * portfolio card reads, so Home and Wallet never disagree on currency, §6.1).
 */
function BalanceWidget() {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const lock = useGetLockStateQuery();
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const [hiddenCats] = useStorageValue<unknown>('wallet.hiddenCats', []);
  const [storedUnit, setStoredUnit] = useStorageValue<BalanceUnit>(BALANCE_UNIT_STORAGE_KEY, DEFAULT_BALANCE_UNIT);
  const unit = isBalanceUnit(storedUnit) ? storedUnit : DEFAULT_BALANCE_UNIT;
  const unlocked = lock.data?.lockState === 'unlocked';
  const balances = useGetCustodyBalancesQuery(undefined, { skip: !unlocked });
  const registry = useGetCatRegistryQuery(undefined, { skip: !unlocked });
  const prices = useGetPricesQuery(undefined, { skip: !unlocked });
  // Skip the exchange-rate fetch entirely while locked — nothing to convert.
  const { fiat, fx } = useFiatPreference(!unlocked);
  const fxLoading = fiat !== 'usd' && fx.isLoading;
  const assets = custodyAssetBalances(balances.data?.balances, watchedCats, { registry: registry.data, hidden: hiddenCats });
  const hero = pickHeroBalance(assets);
  const usd = hero.asset ? assetUsdValue(hero.asset, prices.data ?? {}) : null;
  const fiatState = usd != null ? resolveFiatValue({ usd, fiat, fxRates: fx.data, fxLoading }) : null;
  const display = heroBalanceDisplay({
    unit,
    amountLabel: hero.amountLabel,
    ticker: hero.ticker,
    usd: fiatState?.kind === 'value' ? fiatState.amount : null,
    hasAsset: hero.asset != null,
    pricesLoading: prices.isLoading || fiatState?.kind === 'loading',
    formatUsd: (n) =>
      intl.formatNumber(n, { style: 'currency', currency: (fiatState?.kind === 'value' ? fiatState.currency : 'usd').toUpperCase() }),
  });

  return (
    <div className="dig-widget dig-widget--balance" data-testid="home-balance-card">
      <button type="button" className="dig-balance-tap" data-testid="home-balance" onClick={() => dispatch(setTab('wallet'))}>
        <span className="dig-widget-label"><FormattedMessage id="wallet.portfolio.total" /></span>
        {unlocked ? (
          <>
            <BalanceSlot testid="home-balance-value" className="dig-widget-value" skeletonClassName="dig-balance-skeleton--lg" slot={display.prominent} />
            <BalanceSlot testid="home-balance-secondary" className="dig-muted dig-balance-secondary" skeletonClassName="dig-balance-skeleton--sm" slot={display.secondary} />
          </>
        ) : (
          <span className="dig-widget-value dig-widget-value--muted" data-testid="home-balance-locked">
            <FormattedMessage id="home.wallet.open" />
          </span>
        )}
      </button>
      {unlocked && (
        <button
          type="button"
          className="dig-balance-swap"
          data-testid="home-balance-swap"
          aria-label={intl.formatMessage({ id: 'wallet.balance.swapUnit' })}
          onClick={() => setStoredUnit(toggleBalanceUnit(unit))}
        >
          <span aria-hidden="true">⇄</span>
        </button>
      )}
    </div>
  );
}

/**
 * Render one `heroBalanceDisplay` slot (#156): a real value, a shimmer skeleton while its price
 * fetch is in flight, or a translated status note (e.g. "price unavailable") on genuine failure.
 * `data-testid="${testid}-loading"` marks the skeleton state distinctly so tests can assert the
 * transient loading UI, not just the settled value.
 */
function BalanceSlot({
  slot,
  testid,
  className,
  skeletonClassName,
}: {
  slot: SlotDisplay;
  testid: string;
  className: string;
  skeletonClassName: string;
}) {
  if (slot.kind === 'loading') {
    return (
      <span className={className} data-testid={testid}>
        <span className={`dig-skeleton ${skeletonClassName}`} data-testid={`${testid}-loading`} aria-hidden="true" />
        <span className="dig-visually-hidden"><FormattedMessage id="state.loading" /></span>
      </span>
    );
  }
  return (
    <span className={className} data-testid={testid}>
      {slot.kind === 'status' ? <FormattedMessage id={slot.text ?? 'wallet.portfolio.unavailable'} /> : slot.text}
    </span>
  );
}

/** Send / Receive / Trade quick-action tiles → the wallet on the right sub-view. */
function QuickActions() {
  const dispatch = useAppDispatch();
  const go = (view: 'home' | 'trade') => {
    dispatch(setWalletView(view));
    dispatch(setTab('wallet'));
  };
  return (
    <div className="dig-widget dig-quickactions" data-testid="home-quickactions" role="group" aria-label="Quick actions">
      <button type="button" className="dig-quickaction" data-testid="home-action-send" onClick={() => go('home')}>
        <span className="dig-quickaction-glyph" aria-hidden="true">↑</span>
        <FormattedMessage id="wallet.action.send" />
      </button>
      <button type="button" className="dig-quickaction" data-testid="home-action-receive" onClick={() => go('home')}>
        <span className="dig-quickaction-glyph" aria-hidden="true">⇩</span>
        <FormattedMessage id="receive.title" />
      </button>
      <button type="button" className="dig-quickaction" data-testid="home-action-trade" onClick={() => go('trade')}>
        <span className="dig-quickaction-glyph" aria-hidden="true">⇄</span>
        <FormattedMessage id="wallet.view.trade" />
      </button>
    </div>
  );
}

/** Lock state + node/network status pills → tap opens the Network screen. */
function StatusWidget() {
  const dispatch = useAppDispatch();
  const lock = useGetLockStateQuery();
  const node = useGetNodeStatusQuery();
  const lockState = lock.data?.lockState ?? 'none';
  const reachable = node.data?.reachable === true;
  return (
    <div className="dig-widget dig-statuswidget" data-testid="home-status">
      <span className="dig-widget-label"><FormattedMessage id="home.status.title" /></span>
      <div className="dig-status-pills">
        <span className={`dig-pill dig-pill--${lockState === 'unlocked' ? 'ok' : 'warn'}`} data-testid="home-status-lock">
          <FormattedMessage id={`home.status.lock.${lockState}`} />
        </span>
        <button
          type="button"
          className={`dig-pill dig-pill--${reachable ? 'ok' : 'muted'} dig-pill--btn`}
          data-testid="home-status-node"
          onClick={() => { dispatch(setNetworkView('resolver')); dispatch(setTab('network')); }}
        >
          <FormattedMessage id={reachable ? 'home.status.node.local' : 'home.status.node.gateway'} />
        </button>
      </div>
    </div>
  );
}

/** A peek at the most recent activity → tap opens the wallet's Activity ledger. */
function ActivityPeek() {
  const dispatch = useAppDispatch();
  const lock = useGetLockStateQuery();
  const unlocked = lock.data?.lockState === 'unlocked';
  const activity = useGetCustodyActivityQuery(undefined, { skip: !unlocked });
  // Same dexie registry the Assets list resolves against (#151), so a CAT peeked here shows its real
  // ticker too, not a generic fallback — RTK Query dedupes this against BalanceWidget's own subscription.
  const registry = useGetCatRegistryQuery(undefined, { skip: !unlocked });
  const rows = unlocked ? activityRows(activity.data?.events ?? [], registry.data).slice(0, 2) : [];

  return (
    <button
      type="button"
      className="dig-widget dig-activitypeek"
      data-testid="home-activity"
      onClick={() => { dispatch(setWalletView('activity')); dispatch(setTab('wallet')); }}
    >
      <span className="dig-widget-label"><FormattedMessage id="wallet.view.activity" /></span>
      {rows.length === 0 ? (
        <span className="dig-muted" data-testid="home-activity-empty"><FormattedMessage id="home.activity.empty" /></span>
      ) : (
        <ul className="dig-activitypeek-list">
          {rows.map((r) => (
            <li key={r.id} data-testid={`home-activity-${r.id}`}>
              <span aria-hidden="true">{KIND_GLYPH[r.kind]}</span> <span className="dig-mono">{r.amountLabel}</span> {r.ticker}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

/** The native dApp launcher (first N icons) + "see all" → the Apps screen. Four states. */
function LauncherWidget() {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const { data, isLoading, isError, refetch } = useGetStoreCatalogQuery();
  const apps = data?.apps ?? [];
  return (
    <section className="dig-home-launcher" aria-labelledby="home-apps-title" data-testid="home-launcher-section">
      <div className="dig-toggle-row">
        <h2 className="dig-heading" id="home-apps-title" style={{ margin: 0 }}>
          <FormattedMessage id="apps.title" />
        </h2>
        <button type="button" className="dig-link" data-testid="home-apps-seeall" onClick={() => dispatch(setTab('apps'))}>
          <FormattedMessage id="home.apps.seeAll" />
        </button>
      </div>
      <FourState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && apps.length === 0}
        onRetry={() => void refetch()}
        testid="home-apps"
        loadingId="apps.loading"
        errorId="apps.error"
        emptyId="apps.empty"
        skeleton={<AppLauncherSkeleton count={8} />}
      >
        <AppLauncherGrid apps={apps} limit={HOME_LAUNCHER_LIMIT} testid="home-apps-grid" />
      </FourState>
      <span className="dig-visually-hidden">{intl.formatMessage({ id: 'apps.title' })}</span>
    </section>
  );
}
