import { api } from '@/api/api';
import type { AppStore } from '@/app/store';
import type { NodeLiveStatus } from '@/lib/dig-node-ws';
import type { WalletSyncStatus } from '@/lib/dig-node-wallet-ws';

/** Wallet-data cache tags a pushed node event invalidates so live coin-state changes refresh views. */
const WALLET_DATA_TAGS = ['Balances', 'Activity', 'Coins', 'Collectibles', 'Identity'] as const;

/**
 * Bridge the SW's control-panel broadcasts into the RTK Query cache (#278/#281), so an open popup
 * or fullscreen panel reflects node liveness + pairing changes LIVE with no polling:
 *
 *   - `nodeLiveStatusChanged` → patch the `getNodeLiveStatus` cache entry directly (the WS pushes a
 *     frame ~every 5 s; a direct patch avoids a refetch round-trip per heartbeat).
 *   - `pairingStateChanged`   → invalidate `Pairing` (infrequent, user-driven) so the panel
 *     re-reads the phase (e.g. flips to "paired" the moment the operator approves).
 *
 * Returns an unsubscribe fn. Mirrors `installStorageSync`'s onChanged bridge.
 */
export function installControlPanelSync(store: AppStore): () => void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return () => {};
  }
  const listener = (
    message: { action?: string; status?: NodeLiveStatus; walletSync?: WalletSyncStatus } | undefined,
  ) => {
    if (!message || typeof message.action !== 'string') return;
    if (message.action === 'nodeLiveStatusChanged' && message.status) {
      const status = message.status;
      store.dispatch(
        api.util.updateQueryData('getNodeLiveStatus' as never, undefined as never, () => status as never),
      );
    } else if (message.action === 'walletSyncStatusChanged' && message.walletSync) {
      // #372/#373: the node pushed a sync_status transition over /ws — patch the cache directly so
      // the "Syncing (peak/target)" / disconnected banner flips with no refetch round-trip.
      const walletSync = message.walletSync;
      store.dispatch(
        api.util.updateQueryData('getWalletSyncStatus' as never, undefined as never, () => walletSync as never),
      );
    } else if (message.action === 'nodeWalletDataChanged') {
      // #372: a pushed coin_state/tx event means the wallet's balances/coins/activity changed —
      // invalidate so an open view refetches over the socket with no manual refresh.
      store.dispatch(api.util.invalidateTags([...WALLET_DATA_TAGS] as never));
    } else if (message.action === 'pairingStateChanged') {
      store.dispatch(api.util.invalidateTags(['Pairing' as never]));
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
