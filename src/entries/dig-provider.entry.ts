/**
 * Bundling ENTRY for the injected `window.chia` provider (extension edition, MAIN world).
 *
 * The shipping provider runs in the page's MAIN world where ES `import` is not available, so this
 * entry is bundled by build.js (esbuild, format:'iife') into `dist/dig-provider.js` with the
 * canonical `@dignetwork/chia-provider` surface inlined. The provider object itself comes from the
 * package's `buildProvider` — the SINGLE SOURCE OF TRUTH shared byte-for-byte with the native DIG
 * Browser — so this file only supplies the EXTENSION transport: a `window.postMessage` bridge to
 * the content script, which forwards to the background service worker, which brokers each RPC over
 * WalletConnect to Sage. There is NO hand-copied provider surface here.
 *
 * Transport contract (`bridgeCall`): resolve the wallet's `{status, body}` envelope (or a nullish
 * value on timeout / bridge absence, which the package maps to a 4900 DISCONNECTED error). The
 * package's `rpc` throws on a 202 pending so `connect()` polls — this bridge just relays.
 *
 * Injected into the page's MAIN world at document_start by the content script.
 */
import { buildProvider, type BridgeCall, type ChiaProvider } from '@dignetwork/chia-provider';
import {
  buildRequest,
  newRequestId,
  parseInboundResponse,
  postTargetOrigin,
  PendingRegistry,
  MAX_INFLIGHT,
  type WalletEnvelope,
} from '../lib/provider-channel';

declare global {
  interface Window {
    chia?: ChiaProvider;
  }
}

(function () {
  if (window.chia) return; // never clobber an already-present provider

  // The page's own origin: every request/response on the bridge is posted with — and validated
  // against — this origin end to end (#73), so a cross-origin/foreign-frame message is never
  // processed. An opaque (sandboxed/data:) document falls back to '*' since 'null' is not a valid
  // postMessage targetOrigin.
  const selfOrigin = window.location.origin;
  const target = postTargetOrigin(selfOrigin);

  // Bounded, CSPRNG-id-correlated registry of in-flight requests (#73): a response settles its
  // request EXACTLY once (a forged/duplicate/unknown-id reply is dropped, concurrent requests never
  // cross) and a request flood cannot grow the pending map without bound.
  const pending = new PendingRegistry<WalletEnvelope>(MAX_INFLIGHT);

  // Extension version, read from the manifest at injection time (best-effort; the page world has
  // chrome.runtime.getManifest on Chromium MV3). Reported as window.chia.version.
  let extVersion = 'unknown';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      extVersion = chrome.runtime.getManifest().version || 'unknown';
    }
  } catch {
    /* page world without chrome.runtime */
  }

  // One round-trip to the content-script bridge. Resolves with the wallet's `{status, body}`
  // envelope; on timeout it settles a synthetic status-0 envelope so the package maps it to a
  // DISCONNECTED (4900) error rather than an unhandled rejection.
  const bridgeCall: BridgeCall = (method, params, timeoutMs) =>
    new Promise<WalletEnvelope>((resolve) => {
      const id = newRequestId();
      const timer = setTimeout(() => {
        // status 0 → mapEnvelopeToError → DISCONNECTED (4900): "not reachable".
        pending.settle(id, { status: 0, body: { error: 'DIG wallet request timed out' } });
      }, timeoutMs || 120000);
      // Refuse (rather than overwrite/grow unbounded) when the registry is saturated.
      if (!pending.add(id, { resolve, cleanup: () => clearTimeout(timer) })) {
        clearTimeout(timer);
        resolve({ status: 0, body: { error: 'DIG wallet is busy (too many pending requests)' } });
        return;
      }
      window.postMessage(buildRequest(id, method, (params as Record<string, unknown>) || {}), target);
    });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return; // frame guard: only same-window messages
    const res = parseInboundResponse(event.data, event.origin, selfOrigin);
    if (!res) return; // malformed / cross-origin / wrong-channel → dropped, never thrown on
    pending.settle(res.id, { status: res.status, body: res.body, error: res.error });
  });

  // Build the canonical provider from the shared package + this extension's transport.
  window.chia = buildProvider({ bridgeCall, version: extVersion });

  window.dispatchEvent(new Event('chia#initialized'));
})();

export {};
