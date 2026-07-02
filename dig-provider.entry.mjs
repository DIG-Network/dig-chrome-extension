/**
 * Bundling ENTRY for the injected `window.chia` provider (extension edition, MAIN world).
 *
 * The shipping provider runs in the page's MAIN world where ES `import` is not available, so
 * this entry is bundled by build.js (esbuild, format:'iife') into `dist/dig-provider.js` with the
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
 * Injected into the page's MAIN world at document_start by content.js.
 */
import { buildProvider } from '@dignetwork/chia-provider';

(function () {
  if (window.chia) return; // never clobber an already-present provider

  var pending = {}; // id -> { resolve, reject, timer }

  // Extension version, read from the manifest at injection time (best-effort; the page world has
  // chrome.runtime.getManifest on Chromium MV3). Reported as window.chia.version.
  var EXT_VERSION = 'unknown';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      EXT_VERSION = chrome.runtime.getManifest().version || 'unknown';
    }
  } catch (e) { /* page world without chrome.runtime */ }

  // One round-trip to the content-script bridge. Resolves with the wallet's `{status, body}`
  // envelope; on timeout it resolves a synthetic 5xx-class envelope so the package maps it to a
  // DISCONNECTED (4900) error rather than an unhandled rejection.
  function bridgeCall(method, params, timeoutMs) {
    return new Promise(function (resolve) {
      var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[id];
        // status 0 → mapEnvelopeToError → DISCONNECTED (4900): "not reachable".
        resolve({ status: 0, body: { error: 'DIG wallet request timed out' } });
      }, timeoutMs || 120000);
      pending[id] = { resolve: resolve, timer: timer };
      window.postMessage(
        { type: 'DIG_WALLET_REQUEST', id: id, method: method, params: params || {} },
        '*'
      );
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.type !== 'DIG_WALLET_RESPONSE') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    clearTimeout(p.timer);
    p.resolve({ status: d.status, body: d.body, error: d.error });
  });

  // Build the canonical provider from the shared package + this extension's transport.
  window.chia = buildProvider({ bridgeCall: bridgeCall, version: EXT_VERSION });

  window.dispatchEvent(new Event('chia#initialized'));
})();
