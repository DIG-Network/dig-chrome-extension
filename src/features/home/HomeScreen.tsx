import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { setTab, setWalletView, setNetworkView } from '@/features/ui/uiSlice';
import { useStorageValue } from '@/lib/useStorageValue';
import { FourState } from '@/components/FourState';
import { AppLauncherGrid, AppLauncherSkeleton } from '@/features/apps/AppLauncherGrid';
import { useGetStoreCatalogQuery } from '@/features/apps/appsApi';
import { useGetCustodyBalancesQuery, useGetLockStateQuery, useGetCustodyActivityQuery } from '@/features/wallet/custodyApi';
import { useGetNodeStatusQuery } from '@/features/resolver/resolverApi';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { pickHeroBalance } from '@/features/wallet/portfolio';
import { activityRows } from '@/features/wallet/custody/activityRows';

/** How many dApp icons the Home launcher widget shows before "see all". */
const HOME_LAUNCHER_LIMIT = 8;

/** Glyph per activity kind for the recent-activity peek. */
const KIND_GLYPH: Record<'sent' | 'received' | 'trade', string> = { sent: '↑', received: '⇩', trade: '⇄' };

/**
 * The mobile-OS Home screen (#65) — the launcher above the bottom nav. Arranged like a phone home:
 * a glanceable wallet-balance widget, quick-action tiles (Send / Receive / Trade), the native dApp
 * launcher grid, and status widgets (lock state, node/network status, a recent-activity peek). Every
 * widget deep-links into its full screen. Four states drive the launcher; the wallet widgets degrade
 * gracefully when the wallet is locked or absent. Responsive: one column on the phone popup, a
 * multi-column widget board on the wide tablet/desktop surface.
 */
export function HomeScreen() {
  return (
    <div className="dig-home" data-testid="home-screen">
      <div className="dig-home-board">
        <BalanceWidget />
        <QuickActions />
        <StatusWidget />
        <ActivityPeek />
      </div>
      <LauncherWidget />
    </div>
  );
}

/** Glanceable portfolio value → tap opens the Wallet. Prompts to open/unlock when locked or absent. */
function BalanceWidget() {
  const dispatch = useAppDispatch();
  const lock = useGetLockStateQuery();
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const unlocked = lock.data?.lockState === 'unlocked';
  const balances = useGetCustodyBalancesQuery(undefined, { skip: !unlocked });
  const assets = custodyAssetBalances(balances.data?.balances, watchedCats);
  const hero = pickHeroBalance(assets);

  return (
    <button type="button" className="dig-widget dig-widget--balance" data-testid="home-balance" onClick={() => dispatch(setTab('wallet'))}>
      <span className="dig-widget-label"><FormattedMessage id="wallet.portfolio.total" /></span>
      {unlocked ? (
        <span className="dig-widget-value" data-testid="home-balance-value">
          {hero.amountLabel} <span className="dig-muted">{hero.ticker}</span>
        </span>
      ) : (
        <span className="dig-widget-value dig-widget-value--muted" data-testid="home-balance-locked">
          <FormattedMessage id="home.wallet.open" />
        </span>
      )}
    </button>
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
  const [watchedCats] = useStorageValue<unknown>('wallet.watchedCats', []);
  const unlocked = lock.data?.lockState === 'unlocked';
  const activity = useGetCustodyActivityQuery(undefined, { skip: !unlocked });
  const rows = unlocked ? activityRows(activity.data?.events ?? [], watchedCats).slice(0, 2) : [];

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
