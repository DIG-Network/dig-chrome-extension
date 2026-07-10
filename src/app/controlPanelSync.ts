import { api } from '@/api/api';
import type { AppStore } from '@/app/store';
import type { NodeLiveStatus } from '@/lib/dig-node-ws';

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
  const listener = (message: { action?: string; status?: NodeLiveStatus } | undefined) => {
    if (!message || typeof message.action !== 'string') return;
    if (message.action === 'nodeLiveStatusChanged' && message.status) {
      const status = message.status;
      store.dispatch(
        api.util.updateQueryData('getNodeLiveStatus' as never, undefined as never, () => status as never),
      );
    } else if (message.action === 'pairingStateChanged') {
      store.dispatch(api.util.invalidateTags(['Pairing' as never]));
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
