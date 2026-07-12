// @ts-nocheck
// -----------------------------------------------------------------------------------------------
// MV3 MODULE SERVICE WORKER (§6.4 reorg, #68). This is the extension's background service worker:
// the chia:// read path, the §5.3 node ladder, the message router, self-custody routing, and the
// webNavigation interception. It is BEHAVIOUR-FROZEN infrastructure RELOCATED here verbatim from
// the old root `background.js` — a MOVE, not a rewrite. Like the content-script interception shims
// (src/content/content.ts, page-script.ts) it carries a justified `// @ts-nocheck` + a scoped
// eslint carve-out: it is ~2.7k lines of chrome.* runtime glue whose behaviour is validated by the
// browser SW-registration harness (e2e/sw/) rather than by tsc/vitest, and typing it fully is a
// separate follow-up that must not risk changing the shipped MV3 behaviour during this move.
//
// It is esbuild-BUNDLED into dist/background.js by build.js bundleBackground(): the pure #shared/*
// leaves are inlined, and ./dig_client.js is kept EXTERNAL (a runtime sibling import) because it is
// the wasm-bindgen ESM that loads dig_client_bg.wasm via import.meta.url + the runtime SRI pin.
// -----------------------------------------------------------------------------------------------

// ES module service worker — loaded with "type": "module" in manifest.json (dist/background.js).
// importScripts() is NOT available in module workers; all URN helpers are inlined below.

// ---- WASM glue import (module SW only) ----------------------------------------
// dig_client.js is a wasm-bindgen ES module (uses import.meta.url).
// It CANNOT be loaded via importScripts(). The manifest MUST declare
// "background": { "service_worker": "background.js", "type": "module" }.
import initDigClient, {
  retrievalKey,
  deriveKey,
  verifyInclusion,
  decryptChunk,
  install_global,
} from './dig_client.js';

// Shared URN parser — single source of truth in dig-urn.mjs (ES module).
// background.js previously inlined a divergent copy; it now imports the one parser.
import { parseURN } from '@/lib/dig-urn';

// #289 — §5.3 navigation-target decision: with a LOCAL dig-node reachable, navigate the tab DIRECTLY
// to the node's plaintext serve surface (http://dig.local/s/<store>[:root]/<path>); with no local
// node, keep the sandbox dig-viewer + rpc.dig.net ciphertext path. Pure, unit-tested (dig-nav.test).
// #362/#310 — classifyDigInput + resolveOnDigNetUrn are the ONE shared entry classify/resolve core
// every entry surface funnels through (omnibox, raw urn:/chia:// interception, the toolbar URN bars,
// the custom DIG search resolver) so there is no per-tier reimplementation.
import { chooseNavTarget, classifyDigInput, resolveOnDigNetUrn } from '@/lib/dig-nav';
// #362 Tier 4 — the custom DIG search provider: the sentinel matcher (recognize the search-provider
// hop), the resolver page target, and the configurable fallback web-search engine.
import {
  matchDigSearchSentinel,
  buildFallbackSearchUrl,
  getFallbackTemplate,
  DIG_SEARCH_RESOLVER_PAGE,
} from '@/lib/search-fallback';
// #291 — the omnibox (`dig` keyword) live-suggestion helper, so the address-bar path and the DIG
// Home NTP behave identically (pure, unit-tested in apps.test). Entry NAVIGATION routes through the
// shared `handleResolvedNavigation` core (below); suggestions read `omniboxSuggestions`.
import { omniboxSuggestions } from '@/lib/apps';
// #366 — the toolbar show/hide keyboard command id + the persisted enable/disable key both toolbar
// mounts already react to live via storage.onChanged (no new toggle path needed).
import { TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT, TOOLBAR_TOGGLE_COMMAND } from '@/lib/toolbar';

// The TRUSTED-root decision (#226): a rootless ('latest') URN must verify against the store's
// chain-ANCHORED root, never the literal string 'latest'. These pure helpers own the fail-closed
// verdict; resolveAnchoredRoot() below fetches the anchored root from the node.
import { resolveReadRoots, decideVerified, isRootlessRoot } from '@/lib/trusted-root';

// Branded, plain-language chia:// error page (white theme; never leaks crypto strings).
import { buildErrorPageHtml } from '@/lib/error-page';
// Catalogued, stable chia:// loader error codes (DIG_ERR_*) + the coded-error envelope.
// Aligned with docs.dig.net static/error-codes.json `dig-loader` surface.
import { DIG_ERR, makeError } from '@/lib/error-codes';
// The versioned message catalogue: the frozen ACTIONS enum + getCapabilities self-description.
import { ACTIONS, buildCapabilities, OFFSCREEN_TARGET } from '@/lib/messages';
import { buildFramingBypassRule, APPVIEW_FRAMING_RULE_ID } from '@/lib/framing-rule';
// Self-custody session logic (#56): the offscreen-vault coordination decisions (pure; no chrome.*).
import {
  KEYSTORE_KEY,
  SETTINGS_KEY,
  ACTIVE_WALLET_KEY,
  UNLOCK_EXPIRY_KEY,
  BALANCES_CACHE_KEY,
  ACTIVITY_LOG_KEY,
  OFFER_LOG_KEY,
  OPTION_LOG_KEY,
  LOCK_STATE,
  isCustodyAction,
  isSessionRenewingAction,
  requiresSigningKey,
  shouldApplyRenewal,
  resolveTtlMinutes,
  resolveCoinsetUrl,
  computeUnlockExpiry,
  computeLockSnapshot,
  prepareSendVaultRequest,
} from '@/lib/custody-session';
// Multi-wallet registry (#90): the pure decision layer over the DIGWX1 keystore — migrate a legacy
// single record into a registry, and the add/rename/remove/active-selection transforms. The SW owns
// the chrome.storage.* I/O around these pure helpers.
import {
  WALLETS_KEY,
  migrateRegistry,
  addWallet,
  renameWallet as renameWalletEntry,
  removeWallet as removeWalletEntry,
  findWallet,
  activeRecord,
  nextActiveId,
  toMeta,
  normalizeLabel,
  defaultLabel,
  setWalletActiveIndex,
  setWalletPreviewAddress,
  shouldCachePreviewAddress,
  // Named accounts (#95) — a friendly label over one HD derivation index, layered on #165.
  ensureAccounts,
  addAccount,
  renameAccount as renameAccountEntry,
  removeAccount as removeAccountEntry,
  // Watch-only wallets (#96) — a spend-less wallet imported from a public key only.
  isWatchOnly,
} from '@/lib/wallet-registry';
// Encrypted keystore FILE backup/restore (#115) — the SW never decrypts either direction.
import { buildBackupFile, parseBackupFile, backupFilename } from '@/lib/keystore/backup';
// The LOCAL activity log (#154 — MetaMask-style transaction tracking, replacing the old heavy
// on-chain `includeSpent: true` coinset scan): pure append/confirm/read + balance-delta receive
// detection over the per-wallet+index `ACTIVITY_LOG_KEY` state.
import {
  appendActivityEntry,
  appendActivityEntries,
  markEntryConfirmed,
  entriesFor,
  detectReceivedEntries,
} from '@/lib/activity-log';
// The LOCAL offer log (#101 — "your offers", mirrors the #154 activity log's storage idiom): pure
// append/status-flip/read over the per-wallet+index `OFFER_LOG_KEY` state.
import { appendOfferEntry, markOfferStatus, entriesFor as offerEntriesFor } from '@/lib/offer-log';
// The LOCAL option-contract registry (#104): same append/status-flip/read shape as the offer log,
// over the per-wallet+index `OPTION_LOG_KEY` state — a bare on-chain option carries no recoverable
// terms, so the minting wallet remembers them (see `optionContracts.ts`'s module doc).
import { appendOptionEntry, markOptionStatus, optionEntriesFor } from '@/lib/optionContractLog';
// dexie.space marketplace integration (#102): pure REST client, chrome-free (fetch injected below).
import { postOfferToDexie, fetchDexieOffer, searchDexieOffers } from '@/lib/dexie';
// Watched-CAT parsing (asset ids to scan) — the same shared helper the wallet UI uses.
import { parseWatchedCats } from '@/lib/wallet-assets';
import { DIG_ASSET_ID } from '@/lib/links';
// dig-node install prompt + "dig-node required" error mapping (universal installer link).
import { digNodeInstallPrompt, isDigNodeRequiredError } from '@/lib/dig-node-status';

// dig-dns Path-B proxy fallback (#175, Component C of #174): the shared `.dig`-resolution
// availability signal + engage/disengage decision layer. Chrome-free (fetch/chrome.proxy/clock
// injected below) so the whole state machine is unit-tested under vitest (src/lib/dig-dns.test.ts).
import { createDigDnsAvailabilityController, isDotDigNavigationFailure, shouldRefreshDigDnsSnapshot } from '@/lib/dig-dns';

// Shared dig-node host config (one parser/default for the server.host key) + the local-node
// resolution order (dig.local preferred, 127.0.0.1:port fallback, #287) and reachability probe.
import {
  parseServerHost as parseDigNodeHost,
  resolveDigNode,
  probeDigNode,
} from '@/lib/server-config';

// #217 — the WALLET-DATA source (design D.1/D.2): pick the dig-node's Sage-parity get_* surface
// (node-first, §5.3 ladder) or coinset, per the persisted 4-state chain-source setting. READ-ONLY —
// signing stays in the offscreen vault; the node never receives a key.
import { readChainSourceSetting, resolveWalletSource, verifyNodeTracksConnectedWallet } from '@/lib/wallet-source';
import { makeNodeWalletClient } from '@/lib/node-wallet';

// DIG Control Panel decision logic (the dig://control parity surface): detect a local dig-node
// → manage vs install, the catalogued control.* method names, and the honest hosted-RPC
// fallback. Byte-consistent with the dig-node control RPC contract (dig-companion control.rs).
import {
  decideControlView,
  CONTROL_METHODS,
  isUnauthorizedControlResult,
  CONTROL_TOKEN_HEADER,
} from '@/lib/dig-control';
// #280 control-token pairing controller (pure state machine; wired to the real controlRpc +
// chrome.storage below). The SW owns the paired token; it is never exposed to page content.
import { createPairingController } from '@/lib/dig-pairing';
// #239 live node-status controller: the SW holds a WebSocket to the local node's `/ws/status`,
// re-connecting with backoff, and broadcasts every transition so the popup shows live liveness.
import { createNodeWsController, initialNodeLiveStatus } from '@/lib/dig-node-ws';

// DIG Shields per-resource proof LEDGER (#134, mirrored from the browser): the per-tab/
// per-capsule accumulator of inclusion-proof verdicts the Shield action lists.
import { LedgerStore, groupLedger } from '@/lib/dig-ledger';

// Wallet consent + permissions store: the per-origin consent gate for the injected window.chia
// provider plus the EIP-2255-shaped permission methods. There is NO WalletConnect broker — the
// self-custody dApp router (dapp-approval) serves connect/read/sign against the offscreen vault;
// this module owns only the shared per-origin consent map + connected-sites permissions.
import {
  isOriginApproved,
  setOriginApproval,
  // Granular revocable permissions + connected sites (#67 P0-4).
  isPermissionMethod,
  handlePermissionMethod,
  listPermissions,
  revokeOrigin,
  revokeAllOrigins,
  noteOriginUsage,
} from '@/lib/wallet-broker';

// Self-custody dApp `walletRpc` router + approval queue (#56 §5.5). When a self-custody wallet
// exists, a dApp's window.chia request routes here: connect + reads hit the offscreen vault; a
// sign/message request is enqueued and a dedicated approval window is summoned. The manager is
// chrome-free (its consent lookups, the vault call, and the window summon are injected below).
import { DappApprovalManager } from '@/lib/dapp-approval';

// Phishing / malicious-origin protection (#67 P0-2). A DIG-curated blocklist is refreshed on an
// interval into chrome.storage.local; a blocked origin is refused before connect and every request.
import {
  assessOrigin,
  parseBlocklistPayload,
  PHISHING_BLOCKLIST_KEY,
  DEFAULT_BLOCKLIST_URL,
  BLOCKLIST_REFRESH_MS,
} from '@/lib/phishing';

// SRI for the read-crypto WASM (same artifact + digest as hub.dig.net sw.js and apps/web/lib/dig-client.js).
// Fail closed: a mismatch (tampered/wrong artifact) refuses to run unverified crypto.
const DIG_CLIENT_WASM_SHA256 = "ff486be806f908a2a90780e499a04dbd34e10e3b97be0470cb9ee841a1e49e77";

// Memoised WASM init promise — initialises once across the SW lifetime.
let _digReady = null;

/**
 * Ensure the dig-client WASM is loaded and SRI-verified, then return the
 * named crypto functions.  Safe to call concurrently; only runs init once.
 */
async function ensureDig() {
  if (!_digReady) {
    _digReady = (async () => {
      const res = await fetch(chrome.runtime.getURL('dig_client_bg.wasm'));
      if (!res.ok) throw new Error(`dig-client wasm fetch failed (${res.status})`);
      const bytes = await res.arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== DIG_CLIENT_WASM_SHA256) {
        throw new Error('dig-client wasm integrity check failed — refusing to run unverified crypto');
      }
      await initDigClient({ module_or_path: bytes });
      if (typeof install_global === 'function') install_global();
    })();
  }
  await _digReady;
  return { retrievalKey, deriveKey, verifyInclusion, decryptChunk };
}

// ---- RPC endpoint (prefers a reachable local dig-node; else the hosted rpc.dig.net) -------
const DEFAULT_RPC_ENDPOINT = 'https://rpc.dig.net/';

// The hosted upstream the extension uses when NO local dig-node is reachable. Configurable
// via the options page (`digRpcEndpoint`); defaults to rpc.dig.net.
async function getHostedRpcEndpoint() {
  try {
    const { digRpcEndpoint } = await chrome.storage.local.get('digRpcEndpoint');
    return digRpcEndpoint || DEFAULT_RPC_ENDPOINT;
  } catch {
    return DEFAULT_RPC_ENDPOINT;
  }
}

// Short-TTL cache of the resolved local-node base URL so we don't probe dig.local +
// localhost on every single resource fetch. `null` = "probed, none reachable".
let _localNodeCache = { at: 0, base: undefined };
const LOCAL_NODE_TTL_MS = 10_000;

// Resolve the local dig-node base URL (dig.local preferred, 127.0.0.1:<port> fallback, #287),
// caching the result briefly. Returns the reachable base URL string, or null if the
// dig-node is not running (then the caller uses the hosted endpoint).
async function resolveLocalDigNode() {
  const now = Date.now();
  if (_localNodeCache.base !== undefined && now - _localNodeCache.at < LOCAL_NODE_TTL_MS) {
    return _localNodeCache.base;
  }
  let host;
  try {
    const { 'server.host': h } = await chrome.storage.local.get('server.host');
    host = h;
  } catch { /* default host */ }
  const base = await resolveDigNode(host).catch(() => null);
  _localNodeCache = { at: now, base: base || null };
  return base || null;
}

/**
 * Resolve the content RPC endpoint for a fetch. PREFERS a reachable local dig-node (its
 * JSON-RPC POST root), falling back to the hosted rpc.dig.net. The local node is the user's
 * own machine — faster, private, offline-capable — so it wins when reachable.
 *
 * Mirrors the shared resolution order in server-config.mjs (dig.local → 127.0.0.1:port);
 * here the chosen base becomes the JSON-RPC POST endpoint (trailing slash).
 */
async function getRpcEndpoint() {
  const localBase = await resolveLocalDigNode();
  if (localBase) return localBase.endsWith('/') ? localBase : localBase + '/';
  return getHostedRpcEndpoint();
}

// ─── Wallet-data source (#217, design D.1/D.2) ────────────────────────────────────────────────────
// Distinct from getRpcEndpoint (content reads): this governs the WALLET reads (balances / tokens /
// NFTs / DIDs / coins / activity). The pure 4-state decision lives in wallet-source.ts; here we
// inject the cached §5.3 node resolver + a direct probe for the Custom-URL mode.

/**
 * Resolve the wallet-data source from the persisted chain-source setting + the §5.3 ladder. Also
 * reports the selected `mode` (#222) so callers — the read dispatcher below AND the
 * `getChainSourceStatus` status action — can distinguish an Auto-mode auto-selection from a
 * user-forced node/custom/coinset choice without a second storage read.
 */
async function resolveWalletDataSource() {
  const setting = readChainSourceSetting(await readWalletSettings());
  const resolved = await resolveWalletSource(setting, {
    resolveLadderNode: () => resolveLocalDigNode(),
    probeNode: async (base) => ((await probeDigNode(base).catch(() => false)) ? base : null),
    // #399: the connected self-custody wallet's balances/tokens/coins/activity are sourced from the
    // node ONLY when it is verified to track that wallet's identity. Until the #407 identity
    // handshake is wired, this is false → connected-wallet reads use the self-custody coinset/vault
    // scan of the extension's OWN addresses (never the node's identity-less 0 XCH / 0 $DIG). The
    // node stays the source for CONTENT reads (getRpcEndpoint) — this gate is wallet-data only.
    verifyNodeTracksWallet: verifyNodeTracksConnectedWallet,
  });
  return { mode: setting.mode, resolved };
}

/**
 * Try a wallet-data READ against the dig-node when the resolved source is a node; otherwise tell the
 * caller to use the existing coinset/vault path. Returns:
 *  - `{ handled: true, result }` — the node produced a result, OR a user-FORCED (strict node/custom)
 *    source failed / is unreachable, yielding a `{ success:false, code, message }` the four-state UI
 *    renders (never a silent coinset downgrade).
 *  - `{ handled: false }` — use the coinset/vault path: the source is coinset, OR an `auto` node read
 *    failed and we fall through cleanly.
 * The node client is READ-ONLY (#217 HARD gate) — it never signs or broadcasts.
 */
async function readFromNodeSource(nodeFn) {
  const { resolved: source } = await resolveWalletDataSource();
  if (source.kind === 'coinset') return { handled: false };
  if (source.kind === 'unavailable') {
    return {
      handled: true,
      result: { success: false, code: 'NODE_UNAVAILABLE', message: `dig-node wallet source unavailable (${source.reason})` },
    };
  }
  try {
    return { handled: true, result: await nodeFn(makeNodeWalletClient(source.base)) };
  } catch (e) {
    // A forced (node/custom) source surfaces the error; auto falls through to coinset.
    if (source.strict) {
      return { handled: true, result: { success: false, code: 'NODE_READ_FAILED', message: e instanceof Error ? e.message : String(e) } };
    }
    return { handled: false };
  }
}

// Invalidate the local-node cache whenever the configured host changes so a new value takes
// effect immediately (no stale 10s window after the user edits server.host).
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['server.host'] || changes['server.url'] || changes['server.port'])) {
      _localNodeCache = { at: 0, base: undefined };
    }
  });
} catch { /* storage.onChanged unavailable in some contexts */ }

// #222: warm the §5.3 local-node cache at SW startup/install so the FIRST popup paint (and any
// content read racing it) doesn't pay for a cold probe. `resolveLocalDigNode()` backs BOTH the
// content path (getRpcEndpoint) and the wallet-data path (resolveWalletDataSource) — one warm call
// covers both. Best-effort: a failed probe here is silently retried on the next real caller.
try {
  chrome.runtime.onStartup.addListener(() => { void resolveLocalDigNode().catch(() => {}); });
  chrome.runtime.onInstalled.addListener(() => { void resolveLocalDigNode().catch(() => {}); });
} catch { /* runtime lifecycle events unavailable in some test contexts */ }

// ─── dig-dns Path-B proxy fallback (#175, Component C of #174) ────────────────────────────────
// dig-dns is a SEPARATE OS service (unrelated to the chia:// read path above) that resolves plain
// `http://<label>.dig/` URLs a user types/clicks. It gives the machine two independent ways to
// route `.dig` names: OS split-DNS (Path A) and a chrome.proxy PAC file (Path B). This controller
// is the ONE shared availability signal (`getDigDnsStatus`, SPEC.md §8.5) — it probes dig-dns's
// loopback control endpoints on startup + a periodic alarm, and engages the PAC proxy the moment a
// real `.dig` navigation fails, self-healing once Path A appears to have recovered. Every feature
// (the Resolver tab's indicator, #172's open-by-URN dig-dns-detect branch) reads THIS signal —
// nothing per-feature re-probes dig-dns on its own.
const digDnsController = createDigDnsAvailabilityController({
  chromeProxy: {
    set: (config) => chrome.proxy.settings.set(config),
    clear: (config) => chrome.proxy.settings.clear(config),
  },
});

const DIG_DNS_PROBE_ALARM = 'dig-dns-probe';
try {
  chrome.alarms.create(DIG_DNS_PROBE_ALARM, { periodInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === DIG_DNS_PROBE_ALARM) digDnsController.probe();
  });
} catch { /* alarms unavailable (e.g. under test) */ }
// Best-effort startup probe. A failure just means the signal stays 'unavailable' until the next
// alarm tick or navigation error — never throws, never blocks SW startup.
digDnsController.probe().catch(() => {});

// ─── dig-node control panel (#278/#281): live status + control-token pairing ──────────────────
//
// The SW owns two long-lived controllers for the control panel: a WS liveness channel to the
// local node's `/ws/status` (#239) and the control-token pairing state machine (#280). Both
// broadcast their state so the popup + fullscreen panel reflect changes live with no polling.

/** chrome.storage.local key holding the scoped paired controller token (#280). SW-only. */
const PAIRED_TOKEN_KEY = 'control.pairedToken';

/** Best-effort broadcast to any open popup/app view (they ignore unknown actions). */
function broadcastRuntime(msg) {
  try {
    // A resolved-nowhere promise (no receiver) is expected + harmless.
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch { /* runtime.sendMessage unavailable in some contexts */ }
}

/** The local node's JSON-RPC POST endpoint (base + trailing slash), or null when none is reachable. */
async function controlEndpointOrNull() {
  const base = await resolveLocalDigNode();
  if (!base) return null;
  return base.endsWith('/') ? base : base + '/';
}

async function loadPairedToken() {
  try {
    const { [PAIRED_TOKEN_KEY]: t } = await chrome.storage.local.get(PAIRED_TOKEN_KEY);
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

async function savePairedToken(token) {
  try {
    if (token) await chrome.storage.local.set({ [PAIRED_TOKEN_KEY]: token });
    else await chrome.storage.local.remove(PAIRED_TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

/** The last live node status, so a freshly-opened popup hydrates without waiting for a WS frame. */
let _liveNodeStatus = initialNodeLiveStatus();

const nodeWsController = createNodeWsController({
  resolveBase: resolveLocalDigNode,
  onStatusChange: (status) => {
    _liveNodeStatus = status;
    broadcastRuntime({ action: 'nodeLiveStatusChanged', status });
  },
});
try {
  nodeWsController.start();
} catch { /* no WebSocket in some test contexts */ }

const pairingController = createPairingController({
  requestPairing: async (clientName) => {
    const ep = await controlEndpointOrNull();
    if (!ep) return null;
    const r = await controlRpc(ep, 'pairing.request', { client_name: clientName });
    return r && r.result ? r.result : null;
  },
  pollPairing: async (pairingId) => {
    const ep = await controlEndpointOrNull();
    if (!ep) return null;
    const r = await controlRpc(ep, 'pairing.poll', { pairing_id: pairingId });
    return r && r.result ? r.result : null;
  },
  loadToken: loadPairedToken,
  saveToken: savePairedToken,
  onChange: (state) => broadcastRuntime({ action: 'pairingStateChanged', state }),
});
// Hydrate any previously-stored token → paired, so a returning user is already paired.
void pairingController.hydrate();

// Build a data: URL for the branded, white-theme chia:// error page. Uses the shared
// error-page builder so the message is mapped to a friendly, non-leaking cause (internal
// strings like "decoy or wrong key" are never shown).
function digErrorPageUrl(url, error) {
  const rawMessage = error && error.message ? error.message : String(error || '');
  // If the failure is a local-dig-node-required one (the user pointed the extension at a
  // local node that isn't running), offer the universal installer instead of just "try again".
  const installPrompt = isDigNodeRequiredError(rawMessage)
    ? (({ installLabel, installUrl }) => ({ installLabel, installUrl }))(digNodeInstallPrompt())
    : undefined;
  const html = buildErrorPageHtml({ url, rawMessage, installPrompt });
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// Open the popup to collect per-origin consent. Programmatic popup opening isn't
// universally available, so consent is collected out-of-band: the provider's connect()
// receives 202 (pending) and polls while the user approves the site in the popup's
// "Connection requests" list. We record the pending origin so the popup can surface it.
async function recordPendingOrigin(origin) {
  try {
    const { 'wallet.pendingOrigins': pend } = await chrome.storage.local.get('wallet.pendingOrigins');
    const list = Array.isArray(pend) ? pend : [];
    if (!list.includes(origin)) list.push(origin);
    await chrome.storage.local.set({ 'wallet.pendingOrigins': list });
    // A site is asking to connect, but the popup may be closed (where the user reviews +
    // approves the consent). Flag it so they know to open the extension: a global action
    // badge plus a one-shot notification naming the site.
    signalWalletAttention(origin, list.length);
  } catch { /* best effort */ }
}

// Show a global "needs attention" badge on the toolbar action and fire a notification so
// the user opens the popup to review a pending window.chia connection. The badge is global
// (no tabId) so it shows regardless of the active tab; it is cleared once the pending list
// empties (see clearWalletAttentionIfEmpty).
function signalWalletAttention(origin, pendingCount) {
  try {
    chrome.action.setBadgeText({ text: '●' });
    if (chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ color: '#5800D6' });
    }
    chrome.action.setTitle({
      title: `DIG: ${pendingCount} wallet connection request${pendingCount === 1 ? '' : 's'} — open to review`,
    });
  } catch { /* action may be unavailable */ }
  try {
    if (chrome.notifications && chrome.notifications.create) {
      let site = origin;
      try { site = new URL(origin).host || origin; } catch { /* keep origin */ }
      chrome.notifications.create(`dig-wallet-${origin}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('src/favicon.png'),
        title: 'Wallet connection request',
        message: `${site} wants to connect your Chia wallet. Open the DIG extension to review.`,
        priority: 1,
      });
    }
  } catch { /* notifications may be unavailable / denied */ }
}

// Clear the global wallet-attention badge + title once no origins are pending.
async function clearWalletAttentionIfEmpty() {
  try {
    const { 'wallet.pendingOrigins': pend } = await chrome.storage.local.get('wallet.pendingOrigins');
    if (!Array.isArray(pend) || pend.length === 0) {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'DIG Network Extension' });
    }
  } catch { /* best effort */ }
}

// ---- Verified badge ------------------------------------------------------------
// The native DIG Browser shows a "Verified" badge when a dig:// page's content is
// Merkle-verified against its on-chain root. The extension mirrors this on the toolbar
// action: a green ✓ badge when verified, a red ! when verification failed, cleared
// otherwise. Per-tab verification state is kept so the popup can show a matching line.
// (Extensions can't recolor the omnibox like the browser; the action badge is the
// closest MV3 surface.)
const tabVerification = new Map(); // tabId -> { state: 'verified'|'failed', urn }

// Per-tab DIG Shields proof LEDGER (#134): tabId -> LedgerStore (per-capsule accumulator of
// per-resource inclusion-proof verdicts). The dig-viewer records each resolved resource's
// verdict (via the recordLedgerEntry action) so the popup's Shield action can list the proofs.
// Bounded per capsule by LedgerStore; cleared when the tab navigates away / is closed.
const tabLedger = new Map(); // tabId -> LedgerStore

/** Get (or lazily create) the proof ledger for a tab. */
function ledgerForTab(tabId) {
  let l = tabLedger.get(tabId);
  if (!l) {
    l = new LedgerStore();
    tabLedger.set(tabId, l);
  }
  return l;
}

const BADGE = {
  verified: { text: '✓', color: '#1a8f5a', title: 'DIG: content verified on-chain' },
  failed:   { text: '!', color: '#d92d20', title: 'DIG: verification FAILED — content not trusted' },
};

function setVerifiedBadge(tabId, state, urn) {
  if (typeof tabId !== 'number') return;
  try {
    if (state === 'verified' || state === 'failed') {
      tabVerification.set(tabId, { state, urn: urn || '' });
      const b = BADGE[state];
      chrome.action.setBadgeText({ tabId, text: b.text });
      if (chrome.action.setBadgeBackgroundColor) {
        chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
      }
      chrome.action.setTitle({ tabId, title: b.title });
    } else {
      clearVerifiedBadge(tabId);
    }
  } catch (e) {
    console.warn('DIG Extension: setVerifiedBadge failed', e);
  }
}

function clearVerifiedBadge(tabId) {
  if (typeof tabId !== 'number') return;
  tabVerification.delete(tabId);
  tabLedger.delete(tabId);
  try {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'DIG Network Extension' });
  } catch { /* tab may be gone */ }
}

// Clear the badge when a tab navigates away from DIG content or is closed.
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => { tabVerification.delete(tabId); tabLedger.delete(tabId); });
}
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    const url = details.url || '';
    // dig-viewer (our render page) keeps its badge; a navigation to anything else clears it.
    if (!url.startsWith(chrome.runtime.getURL('dig-viewer.html'))) {
      clearVerifiedBadge(details.tabId);
    }
  });
}

// ---- dig.getContent read helpers (ported from hub.dig.net services/resolver/assets/sw.js) --

/** Decode standard-base64 string to Uint8Array. */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array to base64 in chunks to avoid call-stack overflow on large buffers. */
function bytesToB64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** Infer a MIME type from a file extension (resource key). */
function ctForPath(resourceKey) {
  const ext = (resourceKey.split('.').pop() || '').toLowerCase();
  return ({
    html: 'text/html; charset=utf-8',
    htm:  'text/html; charset=utf-8',
    js:   'text/javascript; charset=utf-8',
    mjs:  'text/javascript; charset=utf-8',
    css:  'text/css; charset=utf-8',
    json: 'application/json',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    svg:  'image/svg+xml',
    webp: 'image/webp',
    ico:  'image/x-icon',
    woff: 'font/woff',
    woff2:'font/woff2',
    txt:  'text/plain',
    pdf:  'application/pdf',
    mp4:  'video/mp4',
    webm: 'video/webm',
    wasm: 'application/wasm',
    xml:  'application/xml',
    md:   'text/markdown',
  }[ext] || 'application/octet-stream');
}

/** One JSON-RPC 2.0 POST.  Throws on transport error or RPC-level error. */
async function rpcCall(endpoint, method, params) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (e) {
    throw new Error('Could not reach the content network. Check your connection.');
  }
  if (!res.ok) throw new Error('dig RPC HTTP error ' + res.status);
  const j = await res.json();
  if (j && j.error) throw new Error('dig RPC ' + method + ': ' + (j.error.message || 'error'));
  return j ? j.result : null;
}

/**
 * POST a CONTROL/admin method (control.*) to a local dig-node's JSON-RPC root and return the
 * FULL parsed JSON-RPC envelope ({ result } | { error: { code, message, data } }) — unlike
 * rpcCall which unwraps to result and throws on error. The Control Panel needs the raw error
 * code to distinguish the expected UNAUTHORIZED (-32030 — CONTROL_ERR.UNAUTHORIZED in
 * dig-control.ts; -32020 is retired/reserved, see #130) reply (node present but the mutating
 * control surface is token-gated, and the extension can't read the on-disk control token) from
 * a real failure.
 *
 * The dig-node reflects the chrome-extension:// CORS origin and allows the control-token header
 * (dig-companion/src/server.rs), so the request reaches the loopback node. We do not (and
 * cannot) populate the X-Dig-Control-Token header — an MV3 extension has no filesystem access —
 * so a node will answer mutating control.* with UNAUTHORIZED, which the caller handles honestly.
 */
async function controlRpc(endpoint, method, params, token) {
  let res;
  const headers = { 'content-type': 'application/json' };
  // #280: a PAIRED controller token authorizes the gated control.* mutations. The OPEN
  // cache.*/pairing.* surface passes no token. The token is a scoped credential the node minted
  // after local operator approval; it is stored in the SW and never exposed to page content.
  if (token) headers[CONTROL_TOKEN_HEADER] = token;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
    });
  } catch (e) {
    // Unreachable loopback node → no envelope; caller treats this as "no status".
    return null;
  }
  if (!res.ok) return { error: { code: -32000, message: 'control RPC HTTP error ' + res.status } };
  try {
    return await res.json();
  } catch {
    return { error: { code: -32700, message: 'control RPC returned non-JSON' } };
  }
}

// RPC back-end caps each window at 3 MiB; loop until `complete`.
const RPC_CHUNK = 3 * 1024 * 1024;

/**
 * Fetch the full ciphertext for a resource from the RPC, reassembling 3-MiB
 * windows.  Mirrors fetchVerifiedCiphertext() in apps/web/lib/dig-client.js.
 * Returns { ciphertext: Uint8Array, proof: string, chunkLens: number[]|null }.
 */
async function fetchVerified(endpoint, storeId, rk, root) {
  let offset = 0;
  let total = null;
  let buf = null;
  let proof = '';
  let chunkLens = null;

  for (;;) {
    const r = await rpcCall(endpoint, 'dig.getContent', {
      store_id: storeId,
      root,
      retrieval_key: rk,
      offset,
      length: RPC_CHUNK,
    });
    if (!r) throw new Error('dig RPC returned no data');
    if (total === null) {
      total = r.total_length >>> 0;
      buf = new Uint8Array(total);
    }
    if (chunkLens === null && Array.isArray(r.chunk_lens)) {
      chunkLens = r.chunk_lens.map((n) => n >>> 0);
    }
    const chunk = b64ToBytes(r.ciphertext || '');
    const at = r.offset >>> 0;
    buf.set(chunk.subarray(0, Math.max(0, Math.min(chunk.length, total - at))), at);
    if (r.inclusion_proof) proof = r.inclusion_proof;
    if (r.complete || r.next_offset == null) break;
    offset = r.next_offset >>> 0;
  }
  return { ciphertext: buf, proof, chunkLens };
}

/**
 * Resolve a store's CHAIN-ANCHORED tip root (lowercase 64-hex) — the TRUSTED root a rootless
 * ('latest') URN must verify against (#226). The root MUST come from the chain, NEVER the serving
 * host. Tries the local dig-node's `dig.getAnchoredRoot` first (it walks the store's DataStore
 * singleton lineage on coinset.org SERVER-SIDE and returns `result.root`). The hosted rpc.dig.net
 * gateway does NOT serve this method (it answers -32601), so on the HOSTED tier — no local node
 * reachable/answering — this falls back to resolving the SAME walk directly against coinset.org via
 * the offscreen vault's DataLayer store-coin driver wasm (#228: `resolveAnchoredRootFromCoinset`
 * below), so a rootless read still verifies with NO local node running. Non-throwing throughout: any
 * RPC/transport/walk failure resolves to null and the caller FAILS CLOSED (content still loads, but
 * is reported unverified) — never a silent trust of the URN string or the serving host.
 */
async function resolveAnchoredRoot(endpoint, storeId) {
  try {
    const r = await rpcCall(endpoint, 'dig.getAnchoredRoot', { store_id: storeId });
    const root = r && typeof r.root === 'string' ? r.root.replace(/^0x/i, '').toLowerCase() : '';
    if (/^[0-9a-f]{64}$/.test(root)) return root;
  } catch {
    // node unreachable / method unavailable (e.g. rpc.dig.net -32601) — fall through to coinset below
  }
  return resolveAnchoredRootFromCoinset(storeId);
}

// #228: a short-lived, SW-lifetime-only cache of the coinset-resolved anchored root, keyed by store
// id. A single rootless page load fetches MANY subresources, each independently calling
// resolveAnchoredRoot() for the SAME store — without this, every subresource would re-walk the FULL
// on-chain singleton lineage via coinset.org from scratch. A `null` (unresolved) result is cached
// too, so a genuinely-unresolvable store doesn't hammer coinset.org once per subresource either.
const _coinsetAnchoredRootCache = new Map();
const COINSET_ANCHORED_ROOT_CACHE_TTL_MS = 20_000;

/**
 * Resolve the chain-anchored root directly from coinset.org (#228 — the hosted rpc.dig.net tier
 * fallback for `resolveAnchoredRoot` above, when the local node is unreachable or doesn't serve
 * `dig.getAnchoredRoot`). Delegates the actual walk to the offscreen document (the DataLayer
 * store-coin driver wasm can only load there — see `offscreen/anchoredRoot.ts`'s doc comment), using
 * whichever coinset endpoint the wallet settings resolve (defaults to api.coinset.org — the SAME
 * default the wallet's own coinset reads use). Non-throwing: any offscreen/coinset/transport failure
 * resolves to null (fail closed).
 */
async function resolveAnchoredRootFromCoinset(storeId) {
  const cached = _coinsetAnchoredRootCache.get(storeId);
  if (cached && Date.now() - cached.at < COINSET_ANCHORED_ROOT_CACHE_TTL_MS) return cached.root;
  let root = null;
  try {
    const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
    const res = await callVault({ op: 'resolveCoinsetAnchoredRoot', storeId, coinsetUrl });
    const candidate = res && res.success && typeof res.root === 'string' ? res.root.replace(/^0x/i, '').toLowerCase() : '';
    if (/^[0-9a-f]{64}$/.test(candidate)) root = candidate;
  } catch {
    root = null; // offscreen document / coinset unreachable → fail closed
  }
  _coinsetAnchoredRootCache.set(storeId, { root, at: Date.now() });
  return root;
}

/**
 * Decrypt multi-chunk ciphertext.  Mirrors decryptResourceChunks() in
 * apps/web/lib/dig-client.js.  `chunkLens` are the per-chunk CIPHERTEXT byte
 * lengths (may be null/empty for a single-chunk resource).
 */
function decryptChunks(dig, keyHex, ciphertext, chunkLens) {
  const lens = chunkLens && chunkLens.length ? chunkLens : [ciphertext.length];
  if (lens.length === 1) return dig.decryptChunk(keyHex, ciphertext); // fast path
  const lensSum = lens.reduce((a, n) => a + n, 0);
  if (lensSum !== ciphertext.length) {
    throw new Error('served ciphertext length does not match chunk lengths');
  }
  const parts = [];
  let p = 0;
  for (const len of lens) {
    parts.push(dig.decryptChunk(keyHex, ciphertext.subarray(p, p + len)));
    p += len;
  }
  const total = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const part of parts) { out.set(part, q); q += part.length; }
  return out;
}

// ---- Legacy server config constants (kept for updateServerConfig message backward compat)
const DEFAULT_SERVER_URL = 'rpc.dig.net';
const DEFAULT_SERVER_PORT = 443;
const DEFAULT_SERVER_HOST = 'rpc.dig.net';

// URN parsing + base36 store-id helpers live in the shared dig-urn.mjs ES module
// (imported at the top of this file). They used to be inlined here as a second
// divergent copy; that copy has been removed so there is one parseURN for the
// whole extension.

// Fetch DIG content via the REAL rpc.dig.net JSON-RPC protocol.
// Performs: retrievalKey → chunked dig.getContent → verifyInclusion → deriveKey → decryptChunks.
// Returns { dataUrl, contentType, urn, fullURN, verified } — callers read .dataUrl unchanged.
// Optional `endpoint` parameter allows the caller to pass a pre-resolved endpoint to avoid
// a second getRpcEndpoint() call (prevents TOCTOU disagreement if the user changes the setting).
async function fetchContentViaRPC(urn, endpoint) {
  try {
    // Normalise: strip chia:// prefix if present
    let urnString = urn.replace(/^chia:\/\//, '');
    const parsed = parseURN(urnString);
    if (!parsed) {
      throw new Error('Invalid URN format');
    }

    // Reconstruct the canonical full URN for logging / return value
    const fullURN = urnString.startsWith('urn:dig:')
      ? urnString
      : `urn:dig:chia:${parsed.storeId}${parsed.roothash ? ':' + parsed.roothash : ''}${parsed.resourceKey ? '/' + parsed.resourceKey : ''}`;

    const storeId     = parsed.storeId;
    // Capsule selection (canonical term — see ../../SYSTEM.md): a rooted URN pins a
    // SPECIFIC capsule (the immutable generation storeId:roothash); a rootless URN
    // ('latest') resolves to the store's current/latest capsule. The TRUSTED root a read is
    // verified against is decided below (#226) — for a rootless URN it is the CHAIN-anchored
    // root, never the literal 'latest'.
    const urnRoot     = parsed.roothash || null;
    const resourceKey = parsed.resourceKey || 'index.html';
    // salt: extracted from ?salt=<hex> by parseURN; null means public store
    const salt        = parsed.salt ?? null;

    console.log('DIG Extension: fetchContentViaRPC — real rpc.dig.net protocol for:', fullURN.substring(0, 60) + '...');

    // 1. Ensure WASM is loaded (SRI-verified, once)
    const dig = await ensureDig();

    // 2. Resolve RPC endpoint (use caller-supplied endpoint to avoid double-resolution TOCTOU)
    const ep = endpoint || (await getRpcEndpoint());

    // 3. Compute retrieval key = SHA-256(canonical rootless URN), hex
    const rk = dig.retrievalKey(storeId, resourceKey);

    // 3b. Resolve the TRUSTED root (#226). A rooted URN pins its own generation; a rootless URN's
    //     trusted root is the store's CHAIN-anchored tip (resolved from the node), NEVER the literal
    //     'latest'. Content is fetched pinned to the resolved generation so the proof it returns
    //     folds to the same root we verify against (no 'latest' race).
    const anchoredRoot = isRootlessRoot(urnRoot) ? await resolveAnchoredRoot(ep, storeId) : null;
    const { trustedRoot, fetchRoot } = resolveReadRoots(urnRoot, anchoredRoot);

    // 4. Fetch ciphertext (chunked, up to 3 MiB windows), pinned to fetchRoot.
    const { ciphertext, proof, chunkLens } = await fetchVerified(ep, storeId, rk, fetchRoot);

    // 5. Verify merkle inclusion against the TRUSTED root (non-throwing; decoys/tamper return false).
    //    Fail-closed: with no resolvable trusted root, `verified` is false regardless of the proof.
    let proofOk = false;
    if (trustedRoot) {
      try {
        proofOk = !!dig.verifyInclusion(ciphertext, proof, trustedRoot);
      } catch {
        proofOk = false;
      }
    }
    const verified = decideVerified(trustedRoot, proofOk);

    // 6. Derive per-resource AES-256 key (salt is the private-store hex salt, or null)
    const keyHex = dig.deriveKey(storeId, resourceKey, salt);

    // 7. Decrypt (GCM-SIV tag failure = decoy or wrong key → throw, caller shows error)
    let bytes;
    try {
      bytes = decryptChunks(dig, keyHex, ciphertext, chunkLens);
    } catch {
      throw new Error('decrypt failed (decoy or wrong key)');
    }

    // 8. Encode to data URL (chunked btoa to avoid call-stack overflow on large buffers)
    const contentType = ctForPath(resourceKey);
    const b64 = bytesToB64(bytes);
    const dataUrl = `data:${contentType};base64,${b64}`;

    console.log('DIG Extension: fetchContentViaRPC success, verified:', verified, 'size:', bytes.length);

    return {
      dataUrl,
      contentType,
      urn,
      fullURN,
      verified,
    };
  } catch (error) {
    console.error('DIG Extension: fetchContentViaRPC failed:', error);
    throw error;
  }
}

// Parse the dig-node host (server.host) into { url, port }. Delegates to the shared
// server-config.mjs parser so the popup, options page, and background all agree on the
// SAME name, default (127.0.0.1:9778 — explicit IPv4, #287; the canonical dig-node control
// port, #132), and parse rules.
const parseServerHost = parseDigNodeHost;

// Get the dig-node config from storage.
async function getServerConfig() {
  const result = await chrome.storage.local.get(['server.host', 'server.url', 'server.port']);

  // The canonical key is server.host.
  if (result['server.host']) {
    return parseServerHost(result['server.host']);
  }

  // Back-compat: older split keys. parseServerHost supplies the dig-node default port.
  if (result['server.url']) {
    return parseServerHost(`${result['server.url']}:${result['server.port'] || ''}`);
  }

  // Nothing configured → the dig-node default.
  return parseServerHost('');
}

// Convert chia:// URL - ALL chia:// URLs now use RPC
// This function is kept for compatibility but all chia:// URLs should go through RPC
async function convertDigUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('chia://')) {
    return url;
  }
  
  // ALL chia:// URLs use RPC - return marker to indicate RPC should be used
  // The actual fetching will be done via fetchContentViaRPC
  return `rpc://${url}`;
}

// Rule ID for dig.local redirect (must be unique and constant)
const DIG_LOCAL_RULE_ID = 1;

// Track processed URLs to prevent infinite redirect loops
const processedUrls = new Map();
const PROCESSED_URL_TTL = 5000; // 5 seconds - URLs expire after this time

// Legacy `isDigLocalResolvable` removed. NOTE: content is NOT hard-defaulted to rpc.dig.net — the
// §5.3 node ladder is honored by `getRpcEndpoint`/`resolveLocalDigNode`, which probe the local node
// (dig.local → 127.0.0.1) FIRST and fall back to the hosted rpc.dig.net gateway only when none is
// reachable. This stub is retained only so any surviving reference doesn't crash (always false);
// all call-sites that acted on a true result have been removed.
async function isDigLocalResolvable() {
  return false;
}

// One-shot cleanup: remove any stale dig.local declarativeNetRequest rules left from
// previous extension versions. No new rules are added — all content goes via RPC POST.
async function removeStaleRedirectRules() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleExists = existingRules.some(rule => rule.id === DIG_LOCAL_RULE_ID);
    if (ruleExists) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [DIG_LOCAL_RULE_ID]
      });
      console.log('DIG Extension: Removed stale dig.local redirect rule');
    }
  } catch (error) {
    console.warn('DIG Extension: Could not clean up old redirect rules:', error);
  }
}

// Load extension state on startup
chrome.runtime.onInstalled.addListener(async (details) => {
  const result = await chrome.storage.local.get(['extensionEnabled']);
  if (result.extensionEnabled === undefined) {
    // Default to enabled
    await chrome.storage.local.set({ extensionEnabled: true });
  }

  // Ecosystem funnel: on a fresh install (not update/reload) open a welcome tab that
  // points the new user at the rest of the DIG Network (dig.net + docs).
  if (details && details.reason === 'install') {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    } catch (e) {
      // Tab creation can fail in some contexts (e.g. no window); funnel is best-effort.
      console.warn('DIG Extension: could not open welcome tab', e);
    }
  }

  // Clean up any stale dig.local redirect rules from previous versions
  await removeStaleRedirectRules();

  // Check for any existing tabs with chia:// URLs (in case extension loaded after tab was opened)
  checkExistingDigTabs();
});

// Check for existing tabs with chia:// URLs and redirect them
async function checkExistingDigTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && tab.url.startsWith('chia://') && !isLocalhostUrl(tab.url)) {
        await redirectDigUrlToLocalhost(tab.id, tab.url);
      } else if (tab.pendingUrl && tab.pendingUrl.startsWith('chia://')) {
        await redirectDigUrlToLocalhost(tab.id, tab.pendingUrl);
      } else if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tab.id, tab.url);
      } else if (tab.pendingUrl && isDigLocalUrl(tab.pendingUrl)) {
        await redirectDigLocalToExtension(tab.id, tab.pendingUrl);
      }
    }
  } catch (error) {
    console.error('DIG Extension: Error checking existing tabs:', error);
  }
}

// Event-driven catch for chia:// tabs. The PRIMARY interceptor is onBeforeNavigate; this
// onUpdated listener is a cheap backstop for the rare case where a tab's url/pendingUrl
// lands on chia:// without firing onBeforeNavigate (e.g. address-bar edge cases), without
// the cost of a tight polling loop. (The old 1s sweep over ALL tabs is gone.)
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const candidate = changeInfo.url || (tab && (tab.pendingUrl || tab.url));
    if (candidate && candidate.startsWith('chia://') && !isLocalhostUrl(candidate)) {
      redirectDigUrlToLocalhost(tabId, candidate);
    }
  });
}

// Also check on startup (not just on install)
chrome.runtime.onStartup.addListener(() => {
  checkExistingDigTabs();
  // Clean up any stale redirect rules that survived an update
  removeStaleRedirectRules();
});

// Error and success reporting storage
const errorReports = [];
const successReports = [];

// ─── Self-custody offscreen vault coordination (#56) ──────────────────────────────────────────
// The decrypted wallet key lives ONLY in the long-lived offscreen document (§5.1). The SW never
// holds it — it creates the offscreen doc on demand, forwards custody requests to the vault, owns
// storage (the encrypted DIGWX1 blob + the non-secret unlock-expiry), and enforces auto-lock
// (idle / TTL / all-windows-close). Pure decisions come from custody-session.mjs.
const OFFSCREEN_URL = 'offscreen.html';
const AUTO_LOCK_ALARM = 'dig-wallet-autolock';
/** #76 — explicit `chrome.idle` detection granularity (seconds of inactivity before 'idle' fires).
 * Chosen to match the AUTO_LOCK_ALARM's 1-minute sweep so the two triggers agree on "how idle is
 * idle"; set explicitly rather than relying on Chrome's own default so this is a documented,
 * intentional value instead of an implicit platform behavior that could silently drift. */
const IDLE_DETECTION_INTERVAL_SECONDS = 60;
/** `chrome.storage.local` key holding the user's watched CAT list (shared with the wallet UI). */
const WATCHED_CATS_KEY = 'wallet.watchedCats';
let creatingOffscreen = null;

async function hasOffscreenDocument() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(ctx) && ctx.length > 0;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * Create the offscreen document if it doesn't exist, coalescing CONCURRENT first-time callers onto
 * the SAME in-flight creation (#228 fix — a real race, not hypothetical: a rootless chia:// page load
 * and an explicit content read can both call this within the same tick the first time, e.g. dig-
 * viewer.html's own initial content fetch racing an extension-triggered `proxyRequest`). The guard
 * MUST be set SYNCHRONOUSLY, before the first `await`, so no concurrent caller can observe
 * `creatingOffscreen` as still null: the OLD code checked `await hasOffscreenDocument()` FIRST — an
 * async yield point — so two callers arriving together could both see "no document yet, not
 * creating yet" and both call `chrome.offscreen.createDocument()`, producing a transient state where
 * a `chrome.runtime.sendMessage` lands before either document is ready to receive it ("Could not
 * establish connection. Receiving end does not exist."). Setting the guard first (line below) closes
 * that window: JS is single-threaded, so between the `if (creatingOffscreen)` check and the
 * assignment there is no `await` for a second caller to interleave into.
 */
async function ensureOffscreenDocument() {
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Hold the self-custody wallet key in memory and run Argon2id + AES-GCM decryption off the ephemeral service worker.',
    });
  })();
  try { await creatingOffscreen; } catch { /* another caller may have created it first (Chrome rejects a duplicate createDocument) */ } finally { creatingOffscreen = null; }
}

/** Forward one request to the offscreen keystore vault (creating the doc if needed). */
async function callVault(request) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, request });
}

async function readKeystore() {
  const out = await chrome.storage.local.get(KEYSTORE_KEY);
  return out[KEYSTORE_KEY] || null;
}

async function readWalletSettings() {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  return out[SETTINGS_KEY] || {};
}

// ─── Multi-wallet registry (#90) ────────────────────────────────────────────────────────────────
// The registry is three storage keys: WALLETS_KEY (every wallet's encrypted record + metadata),
// ACTIVE_WALLET_KEY (the active id), and KEYSTORE_KEY (a MIRROR of the active record so every legacy
// single-wallet read path keeps working). loadRegistry() normalizes them (migrating a pre-#90 single
// keystore into a one-entry registry ONCE), and persistRegistry() writes all three atomically.

/** Persist the normalized registry state: the records+metadata, the active id, and the active mirror. */
async function persistRegistry(state) {
  await chrome.storage.local.set({
    [WALLETS_KEY]: state.wallets,
    [ACTIVE_WALLET_KEY]: state.activeId,
    [KEYSTORE_KEY]: state.keystore, // mirror the active record for the legacy read paths
  });
}

/** Read + normalize the registry; migrate a legacy single keystore into a one-entry registry once. */
async function loadRegistry() {
  const [ks, wl, act] = await Promise.all([
    chrome.storage.local.get(KEYSTORE_KEY),
    chrome.storage.local.get(WALLETS_KEY),
    chrome.storage.local.get(ACTIVE_WALLET_KEY),
  ]);
  const hadRegistry = Array.isArray(wl[WALLETS_KEY]) && wl[WALLETS_KEY].length > 0;
  const state = migrateRegistry({
    legacyKeystore: ks[KEYSTORE_KEY] || null,
    wallets: wl[WALLETS_KEY] || null,
    activeId: act[ACTIVE_WALLET_KEY] || null,
    now: Date.now(),
    genId: () => crypto.randomUUID(),
  });
  // Only write back on the one-time legacy→registry migration, to avoid needless storage churn.
  if (!hadRegistry && state.wallets.length > 0) await persistRegistry(state);
  return state;
}

/**
 * Drop the active-wallet BALANCE cache — it is wallet/index-specific and stale after a switch, and
 * doubles as the #154 receive-delta baseline: a fresh `getCustodyBalances` scan right after a switch
 * has no prior snapshot to diff against, so it correctly SKIPS receive detection instead of
 * misreporting the newly-active wallet/index's existing balance as a fresh "receive". The LOCAL
 * activity LOG (`ACTIVITY_LOG_KEY`) is durable history, not a cache — it is never cleared here;
 * per-wallet+index isolation comes from its own composite storage key (see `lib/activity-log.ts`).
 */
async function clearActiveWalletCaches() {
  try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
}

// ─── Local activity log (#154) — SW-side storage glue over the pure lib/activity-log.ts ──────────

/** Read the raw `ACTIVITY_LOG_KEY` state (an empty object when nothing has been logged yet). */
async function readActivityLogState() {
  const { [ACTIVITY_LOG_KEY]: raw } = await chrome.storage.local.get(ACTIVITY_LOG_KEY);
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Log one action-performed entry (#154) for the ACTIVE wallet + active derivation index, the moment
 * the extension broadcasts it — `pending` until the confirm-poll (`sendStatus`) observes it on-chain.
 * A no-op without an active wallet or a coin id (nothing to key the confirm-poll match on).
 */
async function logActivity(kind, hint, coinId, extra) {
  if (!coinId) return;
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const entry = {
    id: `${kind}:${coinId}`,
    kind,
    asset: hint?.asset ?? 'XCH',
    amount: hint?.amount ?? '0',
    counterparty: hint?.counterparty ?? null,
    coinId,
    timestamp: Date.now(),
    status: 'pending',
    // #152 — a send-with-clawback carries its locked-coin params so the Clawback panel can list it
    // as a pending OUTGOING candidate later (see ACTIONS.listClawbacks).
    ...(extra?.clawback ? { clawback: extra.clawback } : {}),
  };
  const next = appendActivityEntry(await readActivityLogState(), state.activeId, index, entry);
  try { await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: next }); } catch { /* best-effort */ }
}

/** Flip a logged entry to `confirmed` once the confirm-poll (`sendStatus`) sees the coin spent. */
async function confirmActivity(coinId) {
  if (!coinId) return;
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const before = await readActivityLogState();
  const next = markEntryConfirmed(before, state.activeId, index, coinId);
  if (next !== before) {
    try { await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: next }); } catch { /* best-effort */ }
  }
}

/**
 * Balance-delta receive detection (#154): compare `prevBalances` (the pre-scan snapshot) against the
 * just-scanned `nextBalances` and append a `received` entry for every asset that increased. A no-op
 * without a prior snapshot (right after a wallet/index switch — see {@link clearActiveWalletCaches})
 * or an active wallet.
 */
async function logReceivedActivity(prevBalances, nextBalances) {
  if (!prevBalances) return;
  const received = detectReceivedEntries(prevBalances, nextBalances, Date.now());
  if (received.length === 0) return;
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const next = appendActivityEntries(await readActivityLogState(), state.activeId, index, received);
  try { await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: next }); } catch { /* best-effort */ }
}

// ─── Local offer log (#101) — SW-side storage glue over the pure lib/offer-log.ts ────────────────

/** Read the raw `OFFER_LOG_KEY` state (an empty object when nothing has been made yet). */
async function readOfferLogState() {
  const { [OFFER_LOG_KEY]: raw } = await chrome.storage.local.get(OFFER_LOG_KEY);
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Record one MADE offer (#101) for the ACTIVE wallet + active derivation index, right after
 * `makeOffer` succeeds. A no-op without an active wallet (nothing to scope the entry to).
 */
async function recordOffer(offer, offerSummary, coinIdHex) {
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const entry = {
    id: coinIdHex ? `offer:${coinIdHex}` : `offer:${crypto.randomUUID()}`,
    offer,
    summary: offerSummary,
    coinIdHex: coinIdHex ?? null,
    createdAt: Date.now(),
    status: 'open',
  };
  const next = appendOfferEntry(await readOfferLogState(), state.activeId, index, entry);
  try { await chrome.storage.local.set({ [OFFER_LOG_KEY]: next }); } catch { /* best-effort */ }
}

/** Eagerly flip a MADE offer's log entry to `cancelled` — called at `confirmTrade` time (never
 * waits for the next `getOffers` poll, which would otherwise misclassify the spend as `taken`). */
async function markOfferCancelled(coinIdHex) {
  if (!coinIdHex) return;
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const before = await readOfferLogState();
  const next = markOfferStatus(before, state.activeId, index, coinIdHex, 'cancelled');
  if (next !== before) {
    try { await chrome.storage.local.set({ [OFFER_LOG_KEY]: next }); } catch { /* best-effort */ }
  }
}

/**
 * List the ACTIVE wallet + active index's offer log (#101), reconciling every still-`open` entry
 * against the chain first: a coin observed spent (via the SAME `sendStatus` vault op the send/trade
 * confirm-poll uses) that this wallet did NOT itself cancel (see {@link markOfferCancelled}) flips
 * to `taken`. Best-effort — a reconciliation failure for one entry never blocks listing the rest.
 */
async function listOffersReconciled(coinsetUrl) {
  const state = await loadRegistry();
  if (!state.activeId) return [];
  const index = await activeDerivationIndex();
  let logState = await readOfferLogState();
  const entries = offerEntriesFor(logState, state.activeId, index);
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'open' || !e.coinIdHex) continue;
    try {
      const res = await callVault({ op: 'sendStatus', coinId: e.coinIdHex, coinsetUrl });
      if (res && res.confirmed === true) {
        const next = markOfferStatus(logState, state.activeId, index, e.coinIdHex, 'taken');
        if (next !== logState) {
          logState = next;
          changed = true;
        }
      }
    } catch { /* best-effort — an unreachable coinset leaves this entry `open` for the next poll */ }
  }
  if (changed) {
    try { await chrome.storage.local.set({ [OFFER_LOG_KEY]: logState }); } catch { /* best-effort */ }
  }
  return offerEntriesFor(logState, state.activeId, index);
}

/** Read the raw `OPTION_LOG_KEY` state (an empty object when nothing has been minted yet). */
async function readOptionLogState() {
  const { [OPTION_LOG_KEY]: raw } = await chrome.storage.local.get(OPTION_LOG_KEY);
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Record one MINTED option (#104) for the ACTIVE wallet + active derivation index, right after
 * `confirmOptionMint` broadcasts successfully. A no-op without an active wallet.
 */
async function recordOption(record) {
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const entry = { record, createdAt: Date.now(), status: 'open' };
  const next = appendOptionEntry(await readOptionLogState(), state.activeId, index, entry);
  try { await chrome.storage.local.set({ [OPTION_LOG_KEY]: next }); } catch { /* best-effort */ }
}

/** Eagerly flip a MINTED option's log entry to `exercised` — called at `confirmOptionExercise`
 * time (never waits for the next `getOptions` poll). */
async function markOptionExercised(coinIdHex) {
  if (!coinIdHex) return;
  const state = await loadRegistry();
  if (!state.activeId) return;
  const index = await activeDerivationIndex();
  const before = await readOptionLogState();
  const next = markOptionStatus(before, state.activeId, index, coinIdHex, 'exercised');
  if (next !== before) {
    try { await chrome.storage.local.set({ [OPTION_LOG_KEY]: next }); } catch { /* best-effort */ }
  }
}

/**
 * List the ACTIVE wallet + active index's option registry (#104), reconciling every still-`open`
 * entry against the chain first (the SAME `sendStatus` vault op the send/trade confirm-poll uses):
 * a coin observed spent flips to `exercised` (MVP has no clawback path, so "spent" only ever means
 * that). Best-effort — a reconciliation failure for one entry never blocks listing the rest.
 */
async function listOptionsReconciled(coinsetUrl) {
  const state = await loadRegistry();
  if (!state.activeId) return [];
  const index = await activeDerivationIndex();
  let logState = await readOptionLogState();
  const entries = optionEntriesFor(logState, state.activeId, index);
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'open') continue;
    try {
      const res = await callVault({ op: 'sendStatus', coinId: e.record.coinIdHex, coinsetUrl });
      if (res && res.confirmed === true) {
        const next = markOptionStatus(logState, state.activeId, index, e.record.coinIdHex, 'exercised');
        if (next !== logState) {
          logState = next;
          changed = true;
        }
      }
    } catch { /* best-effort — an unreachable coinset leaves this entry `open` for the next poll */ }
  }
  if (changed) {
    try { await chrome.storage.local.set({ [OPTION_LOG_KEY]: logState }); } catch { /* best-effort */ }
  }
  return optionEntriesFor(logState, state.activeId, index);
}

/**
 * Read the ACTIVE wallet's active HD derivation index (#165 — the single active-index model)
 * directly from storage. A light read (no full migration/normalization like {@link loadRegistry}),
 * so it's cheap to call on every wallet read/send op — every one of them derives ONLY this index
 * (both schemes), never a multi-index sweep. Defaults to 0 (no wallet / entry not found).
 */
async function activeDerivationIndex() {
  const [active, wl] = await Promise.all([
    chrome.storage.local.get(ACTIVE_WALLET_KEY),
    chrome.storage.local.get(WALLETS_KEY),
  ]);
  const wallets = Array.isArray(wl[WALLETS_KEY]) ? wl[WALLETS_KEY] : [];
  const entry = findWallet(wallets, active[ACTIVE_WALLET_KEY] || null);
  return entry?.activeIndex ?? 0;
}

/**
 * #96 — the ACTIVE wallet's watch-only public key, when it IS a watch-only entry; `undefined` for an
 * ordinary custody wallet. Read/derive ops pass this straight through to the vault so a watch-only
 * wallet's addresses/balances derive from the public key instead of relying on an unlocked seed.
 */
async function activeWatchPublicKeyHex() {
  const [active, wl] = await Promise.all([
    chrome.storage.local.get(ACTIVE_WALLET_KEY),
    chrome.storage.local.get(WALLETS_KEY),
  ]);
  const wallets = Array.isArray(wl[WALLETS_KEY]) ? wl[WALLETS_KEY] : [];
  const entry = findWallet(wallets, active[ACTIVE_WALLET_KEY] || null);
  return isWatchOnly(entry) ? entry.watchPublicKeyHex : undefined;
}

/**
 * Opportunistically cache the active wallet's canonical (index-0) receive address onto its
 * registry entry (#176 — the wallet switcher's per-row address preview). Called after every
 * `getReceiveAddress` read; a no-op unless {@link shouldCachePreviewAddress} says this read is the
 * canonical one AND it actually changed, so a wallet's preview only ever reflects its own index-0
 * address, never whichever index the user currently happens to be viewing.
 */
async function cachePreviewAddressIfNeeded(activeIndex: number, address: string | undefined) {
  const state = await loadRegistry();
  if (!state.activeId) return;
  const active = findWallet(state.wallets, state.activeId);
  if (!active || !shouldCachePreviewAddress(activeIndex, active.previewAddress, address)) return;
  const wallets = setWalletPreviewAddress(state.wallets, state.activeId, address);
  await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
}

/** Start (or extend) the unlock window: persist the non-secret expiry + arm the auto-lock alarm. */
async function startUnlockWindow() {
  const ttl = resolveTtlMinutes(await readWalletSettings());
  const expiry = computeUnlockExpiry(Date.now(), ttl);
  await chrome.storage.session.set({ [UNLOCK_EXPIRY_KEY]: expiry });
  try { chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 }); } catch { /* alarms unavailable */ }
  return expiry;
}

/** Tell the vault to zeroize + drop the key and clear the unlock window. */
async function lockVaultNow() {
  try { if (await hasOffscreenDocument()) await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, request: { op: 'lockWallet' } }); } catch { /* best effort */ }
  await chrome.storage.session.remove(UNLOCK_EXPIRY_KEY);
  try { chrome.alarms.clear(AUTO_LOCK_ALARM); } catch { /* ignore */ }
}

/**
 * Compute the tri-state lock snapshot the UI reads, PURELY from persisted storage — the encrypted
 * keystore blob (storage.local) + the non-secret unlock-expiry (storage.session). It does NOT
 * round-trip to the offscreen vault, so it ALWAYS resolves immediately; a no-wallet user (with no
 * offscreen document) resolves instantly to `none` → onboarding, instead of hanging on "Loading
 * wallet" (#68). Auto-lock (TTL sweep alarm + idle) independently zeroizes the vault when the
 * unlock window lapses, so a lapsed TTL reads as `locked` here without needing a vault call.
 * Also carries the active wallet's active derivation index (#165) so the index navigator hydrates
 * from this SAME poll — another light storage read, still no vault round-trip.
 */
async function getLockStateSnapshot() {
  const [record, sess, active, wl] = await Promise.all([
    readKeystore(),
    chrome.storage.session.get(UNLOCK_EXPIRY_KEY),
    chrome.storage.local.get(ACTIVE_WALLET_KEY),
    chrome.storage.local.get(WALLETS_KEY),
  ]);
  const activeWalletId = active[ACTIVE_WALLET_KEY] || null;
  const wallets = Array.isArray(wl[WALLETS_KEY]) ? wl[WALLETS_KEY] : [];
  const activeEntry = findWallet(wallets, activeWalletId);
  return computeLockSnapshot({
    hasKeystore: !!record,
    activeWalletId,
    unlockExpiry: sess[UNLOCK_EXPIRY_KEY] || null,
    activeIndex: activeEntry?.activeIndex ?? 0,
    // #96 — a watch-only active wallet has no keystore blob at all and is never "locked".
    isWatchActive: isWatchOnly(activeEntry),
    now: Date.now(),
  });
}

/**
 * Handle one custody action end-to-end (SW ↔ offscreen ↔ storage), then — if the action is real
 * wallet activity (#155, {@link isSessionRenewingAction}) and the wallet was ALREADY unlocked when
 * the request arrived — slide the idle auto-lock window forward. This is what makes "unlocked"
 * mean "unlocked while actively used" (MetaMask-style) rather than a fixed span from the original
 * unlock: an actively-used wallet never re-prompts mid-session, only genuine inactivity (or an
 * explicit Lock) ends it. `unlockWallet`/`createWallet`/`importWallet`/`switchWallet` already start
 * their own window on a locked→unlocked transition; renewing again here on top of that is a
 * harmless no-op.
 *
 * The renewal is a compare-and-swap ({@link shouldApplyRenewal}), not a blind "was unlocked at the
 * start ⇒ renew at the end": the unlock-expiry observed when the action STARTED is captured, and
 * the window is re-armed only if that SAME value is still current once the action finishes. This
 * closes a real race — a slower renewing call (e.g. a balance scan) that began while unlocked must
 * NOT resurrect the session if an explicit `lockWallet` (or the TTL sweep) completed while it was
 * still in flight; an explicit lock always wins over an in-flight activity call.
 */
async function handleCustodyAction(message) {
  const renews = isSessionRenewingAction(message && message.action);
  const before = renews ? await getLockStateSnapshot() : null;
  const expiryAtStart = before && before.lockState === LOCK_STATE.UNLOCKED ? before.unlockExpiry : null;
  const result = await handleCustodyActionInner(message);
  if (expiryAtStart != null) {
    const sess = await chrome.storage.session.get(UNLOCK_EXPIRY_KEY);
    if (shouldApplyRenewal(expiryAtStart, sess[UNLOCK_EXPIRY_KEY])) await startUnlockWindow();
  }
  return result;
}

/** The action dispatch table for {@link handleCustodyAction} (SW ↔ offscreen ↔ storage). */
async function handleCustodyActionInner(message) {
  // #96 — a signing-required action (send/sign/reveal-a-secret) is refused BEFORE it ever reaches
  // the vault when the ACTIVE wallet is a spend-less watch-only entry (it holds no secret at all).
  // Read-only actions (balances/addresses/lists) are unaffected — they route through the public-key
  // derivation path instead (see the getReceiveAddress/getCustodyBalances/listDerivedAddresses cases).
  if (requiresSigningKey(message.action)) {
    const state = await loadRegistry();
    if (isWatchOnly(findWallet(state.wallets, state.activeId))) {
      return { success: false, code: 'WATCH_ONLY', message: 'watch-only wallets cannot sign or spend' };
    }
  }
  switch (message.action) {
    case ACTIONS.getLockState:
      return getLockStateSnapshot();
    case ACTIONS.lockWallet:
      await lockVaultNow();
      return { lockState: LOCK_STATE.LOCKED };
    case ACTIONS.createWallet: {
      // ADD a wallet: fresh id, its own DIGWX1 record, appended to the registry + made active (#90).
      const state = await loadRegistry();
      const walletId = crypto.randomUUID();
      const label = normalizeLabel(message.label, defaultLabel(state.wallets.length + 1));
      const res = await callVault({ op: 'createWallet', walletId, password: message.password, label, strong: message.strong });
      if (!res || res.success === false) return res || { success: false, code: 'CUSTODY_ERROR', message: 'create failed' };
      const entry = { id: walletId, label, record: res.record, createdAt: Date.now(), activeIndex: 0 };
      await persistRegistry({ wallets: addWallet(state.wallets, entry), activeId: walletId, keystore: res.record });
      await clearActiveWalletCaches();
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, mnemonic: res.mnemonic, usedFallback: res.usedFallback, activeWalletId: walletId };
    }
    case ACTIONS.importWallet: {
      // ADD an imported wallet: fresh id, its own record, appended + made active (#90).
      const state = await loadRegistry();
      const walletId = crypto.randomUUID();
      const label = normalizeLabel(message.label, defaultLabel(state.wallets.length + 1));
      const res = await callVault({ op: 'importWallet', walletId, mnemonic: message.mnemonic, password: message.password, label, strong: message.strong });
      if (!res || res.success === false) return res || { success: false, code: 'CUSTODY_ERROR', message: 'import failed' };
      const entry = { id: walletId, label, record: res.record, createdAt: Date.now(), activeIndex: 0 };
      await persistRegistry({ wallets: addWallet(state.wallets, entry), activeId: walletId, keystore: res.record });
      await clearActiveWalletCaches();
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, usedFallback: res.usedFallback, activeWalletId: walletId };
    }
    case ACTIONS.unlockWallet: {
      // Unlock the ACTIVE wallet, caching its key in the vault under the active id (#90).
      const state = await loadRegistry();
      if (!state.keystore) return { success: false, code: 'NO_WALLET', message: 'no wallet to unlock' };
      const res = await callVault({ op: 'unlockWallet', walletId: state.activeId, password: message.password, record: state.keystore });
      if (!res || res.success === false) return res || { success: false, code: 'UNLOCK_FAILED', message: 'unlock failed' };
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, usedFallback: res.usedFallback, activeWalletId: state.activeId };
    }
    case ACTIONS.revealPhrase: {
      const record = await readKeystore();
      if (!record) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      return callVault({ op: 'revealPhrase', password: message.password, record });
    }
    case ACTIONS.exportPrivateKey: {
      // #96 — the raw (pre-synthetic) account secret key at the active index, both schemes. Watch-only
      // is already rejected by the top-of-dispatch guard above (it has no record to decrypt anyway).
      const record = await readKeystore();
      if (!record) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      return callVault({ op: 'exportPrivateKey', password: message.password, record, activeIndex: await activeDerivationIndex() });
    }
    case ACTIONS.listWallets: {
      // Record-FREE metadata + the active id (the encrypted records never leave the SW).
      const state = await loadRegistry();
      return { wallets: toMeta(state.wallets, state.activeId), activeWalletId: state.activeId };
    }
    case ACTIONS.switchWallet: {
      // Activate another wallet. Instant if its key is already cached in the vault; else, with a
      // password, unlock it now; else NEEDS_UNLOCK so the UI prompts for that wallet's password.
      const state = await loadRegistry();
      const target = findWallet(state.wallets, message.walletId);
      if (!target) return { success: false, code: 'NO_WALLET', message: 'unknown wallet' };
      let res = await callVault({ op: 'switchWallet', walletId: target.id });
      if (!res || res.success === false) {
        if (res && res.code === 'NEEDS_UNLOCK') {
          if (!message.password) return { success: false, code: 'NEEDS_UNLOCK', message: 'wallet locked' };
          res = await callVault({ op: 'unlockWallet', walletId: target.id, password: message.password, record: target.record });
          if (!res || res.success === false) return res || { success: false, code: 'UNLOCK_FAILED', message: 'unlock failed' };
        } else {
          return res || { success: false, code: 'CUSTODY_ERROR', message: 'switch failed' };
        }
      }
      await persistRegistry({ wallets: state.wallets, activeId: target.id, keystore: target.record });
      await clearActiveWalletCaches();
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, activeWalletId: target.id };
    }
    case ACTIONS.renameWallet: {
      const state = await loadRegistry();
      const label = normalizeLabel(message.label, '');
      if (!label) return { success: false, code: 'BAD_REQUEST', message: 'label required' };
      if (!findWallet(state.wallets, message.walletId)) return { success: false, code: 'NO_WALLET', message: 'unknown wallet' };
      const wallets = renameWalletEntry(state.wallets, message.walletId, label);
      await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
      return { success: true, wallets: toMeta(wallets, state.activeId), activeWalletId: state.activeId };
    }
    case ACTIONS.removeWallet: {
      // Drop a wallet (zeroize its cached key). Never remove the last wallet; re-home the active one.
      const state = await loadRegistry();
      if (!findWallet(state.wallets, message.walletId)) return { success: false, code: 'NO_WALLET', message: 'unknown wallet' };
      if (state.wallets.length <= 1) return { success: false, code: 'LAST_WALLET', message: 'cannot remove the last wallet' };
      const wasActive = state.activeId === message.walletId;
      const wallets = removeWalletEntry(state.wallets, message.walletId);
      const activeId = nextActiveId(wallets, wasActive ? null : state.activeId);
      await callVault({ op: 'forgetWallet', walletId: message.walletId });
      let lockState = LOCK_STATE.UNLOCKED;
      if (wasActive) {
        // Keep the session unlocked only if the new active wallet's key is still cached; else lock so
        // the gate prompts to unlock it.
        const sw = await callVault({ op: 'switchWallet', walletId: activeId });
        if (!sw || sw.success === false) { await lockVaultNow(); lockState = LOCK_STATE.LOCKED; }
      }
      await persistRegistry({ wallets, activeId, keystore: activeRecord(wallets, activeId) });
      await clearActiveWalletCaches();
      return { success: true, wallets: toMeta(wallets, activeId), activeWalletId: activeId, lockState };
    }
    case ACTIONS.importWatchWallet: {
      // Watch-only (#96): add a spend-less wallet from a master/root public key only — NO password,
      // NO seed. Validate the key + preview its index-0 address/fingerprint in ONE offscreen-vault
      // round trip (reusing getReceiveAddress's watchPublicKeyHex path) before ever adding it.
      if (!message.publicKeyHex) return { success: false, code: 'BAD_REQUEST', message: 'publicKeyHex required' };
      const preview = await callVault({ op: 'getReceiveAddress', watchPublicKeyHex: message.publicKeyHex, activeIndex: 0 });
      if (!preview || preview.success === false) {
        return preview || { success: false, code: 'INVALID_PUBLIC_KEY', message: 'not a valid BLS public key' };
      }
      const state = await loadRegistry();
      const walletId = crypto.randomUUID();
      const label = normalizeLabel(message.label, defaultLabel(state.wallets.length + 1));
      const entry = {
        id: walletId,
        label,
        createdAt: Date.now(),
        activeIndex: 0,
        kind: 'watch',
        watchPublicKeyHex: message.publicKeyHex,
        watchFingerprint: preview.fingerprint,
        previewAddress: preview.address,
      };
      // A watch-only wallet has no encrypted record; persist it alongside the others without touching
      // the `wallet.keystore` legacy mirror (which only ever mirrors a CUSTODY wallet's record).
      await chrome.storage.local.set({ [WALLETS_KEY]: addWallet(state.wallets, entry), [ACTIVE_WALLET_KEY]: walletId });
      await clearActiveWalletCaches();
      return { success: true, activeWalletId: walletId, address: preview.address, fingerprint: preview.fingerprint };
    }
    case ACTIONS.exportWalletBackup: {
      // Keystore file backup (#115): export ONE wallet's own existing encrypted record as a
      // downloadable JSON envelope. The SW never decrypts it — copied byte-for-byte.
      const state = await loadRegistry();
      const target = findWallet(state.wallets, message.walletId);
      if (!target) return { success: false, code: 'NO_WALLET', message: 'unknown wallet' };
      if (isWatchOnly(target)) return { success: false, code: 'WATCH_ONLY', message: 'a watch-only wallet has nothing encrypted to export' };
      const file = buildBackupFile({ label: target.label, createdAt: target.createdAt, record: target.record });
      return { success: true, filename: backupFilename(target.label), json: JSON.stringify(file) };
    }
    case ACTIONS.importWalletBackup: {
      // Keystore file backup (#115): restore a wallet from a previously-exported backup file's JSON
      // text. Validates structurally (never decrypts); lands LOCKED (no password was ever supplied).
      const parsed = parseBackupFile(message.json || '');
      if (!parsed.ok) return { success: false, code: parsed.code, message: 'not a valid DIG wallet backup file' };
      const state = await loadRegistry();
      const alreadyExists = state.wallets.some((w) => w.record && w.record.ciphertext === parsed.backup.record.ciphertext);
      if (alreadyExists) return { success: false, code: 'ALREADY_EXISTS', message: 'this wallet is already added' };
      const walletId = crypto.randomUUID();
      const label = normalizeLabel(message.label || parsed.backup.label, defaultLabel(state.wallets.length + 1));
      const entry = { id: walletId, label, record: parsed.backup.record, createdAt: parsed.backup.createdAt, activeIndex: 0 };
      await persistRegistry({ wallets: addWallet(state.wallets, entry), activeId: walletId, keystore: parsed.backup.record });
      await clearActiveWalletCaches();
      // No password was ever seen during restore — the vault never cached a key for this wallet id,
      // so the wallet comes back LOCKED and the normal unlock screen gates it (same as any not-yet-
      // unlocked wallet in the switcher, §18.16).
      return { success: true, activeWalletId: walletId, lockState: LOCK_STATE.LOCKED };
    }
    case ACTIONS.addAccount: {
      // Named accounts (#95): append a new account to the ACTIVE wallet at the next unused index.
      const state = await loadRegistry();
      if (!state.activeId) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      const wallets = addAccount(state.wallets, state.activeId, message.label);
      await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
      const entry = findWallet(wallets, state.activeId);
      return { success: true, accounts: entry ? entry.accounts : [] };
    }
    case ACTIONS.renameAccount: {
      const state = await loadRegistry();
      if (!state.activeId) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      const label = normalizeLabel(message.label, '');
      if (!label || !message.accountId) return { success: false, code: 'BAD_REQUEST', message: 'accountId + label required' };
      const wallets = renameAccountEntry(state.wallets, state.activeId, message.accountId, label);
      await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
      const entry = findWallet(wallets, state.activeId);
      return { success: true, accounts: entry ? entry.accounts : [] };
    }
    case ACTIONS.removeAccount: {
      // Removing the currently-ACTIVE account re-homes activeIndex (removeAccountEntry does this
      // itself), so every index-scoped cache must be dropped exactly like setActiveIndex.
      const state = await loadRegistry();
      if (!state.activeId) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      if (!message.accountId) return { success: false, code: 'BAD_REQUEST', message: 'accountId required' };
      const before = findWallet(state.wallets, state.activeId);
      const beforeAccounts = before ? ensureAccounts(before) : [];
      if (!beforeAccounts.some((a) => a.id === message.accountId)) {
        return { success: false, code: 'BAD_REQUEST', message: 'unknown account' };
      }
      if (beforeAccounts.length <= 1) return { success: false, code: 'LAST_ACCOUNT', message: 'cannot remove the last account' };
      const wallets = removeAccountEntry(state.wallets, state.activeId, message.accountId);
      await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
      const after = findWallet(wallets, state.activeId);
      if (before && after && before.activeIndex !== after.activeIndex) await clearActiveWalletCaches();
      return { success: true, accounts: after ? after.accounts : [] };
    }
    case ACTIONS.setActiveIndex: {
      // Navigate the ACTIVE wallet's active HD derivation index (#165 — prev/next/jump). A pure SW
      // registry op (like renameWallet) — no vault round-trip, no key involved. Every derived view
      // (balances/assets/NFTs/DIDs/activity/receive) is scoped to this index, so the caches (keyed
      // to the PREVIOUS index) must be dropped.
      const state = await loadRegistry();
      if (!state.activeId) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      const wallets = setWalletActiveIndex(state.wallets, state.activeId, message.index);
      await persistRegistry({ wallets, activeId: state.activeId, keystore: activeRecord(wallets, state.activeId) });
      await clearActiveWalletCaches();
      const entry = findWallet(wallets, state.activeId);
      return { success: true, activeIndex: entry ? entry.activeIndex : 0 };
    }
    case ACTIONS.getReceiveAddress: {
      const activeIndex = await activeDerivationIndex();
      const watchPublicKeyHex = await activeWatchPublicKeyHex();
      const res = await callVault({ op: 'getReceiveAddress', activeIndex, ...(watchPublicKeyHex ? { watchPublicKeyHex } : {}) });
      // #96 — the preview-address cache is a custody-wallet convenience (§176); skip it for a
      // watch-only wallet (it has no registry `record` to fold the cache write into).
      if (!watchPublicKeyHex && res && typeof res.address === 'string') await cachePreviewAddressIfNeeded(activeIndex, res.address);
      return res;
    }
    case ACTIONS.listDerivedAddresses: {
      // #106 — a read-only page of BOTH-scheme addresses (indexes 0..count-1) for viewing/copying;
      // pure local derivation, independent of the active index (#165 is unaffected). A watch-only
      // wallet's page (#96) is unhardened-only — hardened is unreachable from a public key alone.
      const watchPublicKeyHex = await activeWatchPublicKeyHex();
      return callVault({ op: 'listDerivedAddresses', count: message.count, ...(watchPublicKeyHex ? { watchPublicKeyHex } : {}) });
    }
    case ACTIONS.getCustodyBalances: {
      const settings = await readWalletSettings();
      const coinsetUrl = resolveCoinsetUrl(settings);
      const { [WATCHED_CATS_KEY]: watchedRaw } = await chrome.storage.local.get(WATCHED_CATS_KEY);
      // Auto-discovery surfaces every held CAT; the watch list is the explicit override, and the
      // built-in $DIG is always queried directly so its balance resolves even if held as un-hinted change.
      const watchedCats = [...new Set([DIG_ASSET_ID.toLowerCase(), ...parseWatchedCats(watchedRaw).map((c) => c.assetId)])];
      // #154 — the PRE-scan snapshot is the receive-delta baseline; read it before it's overwritten.
      const { [BALANCES_CACHE_KEY]: prevCache } = await chrome.storage.local.get(BALANCES_CACHE_KEY);
      // #217 — node-first: source balances from the dig-node's Sage-parity get_sync_status/get_cats
      // when the resolved source is a node; else fall through to the coinset/vault scan below.
      const nodeBal = await readFromNodeSource((c) => c.getBalances());
      if (nodeBal.handled) {
        if (nodeBal.result.success === false) return nodeBal.result;
        const balances = nodeBal.result; // { xch, cats }
        await logReceivedActivity(prevCache?.balances, balances);
        await chrome.storage.local.set({ [BALANCES_CACHE_KEY]: { balances, at: Date.now() } });
        return { balances, cached: false };
      }
      const watchPublicKeyHex = await activeWatchPublicKeyHex();
      const res = await callVault({
        op: 'scanBalances',
        watchedCats,
        activeIndex: await activeDerivationIndex(),
        coinsetUrl,
        ...(watchPublicKeyHex ? { watchPublicKeyHex } : {}),
      });
      if (res && res.success !== false && res.balances) {
        await logReceivedActivity(prevCache?.balances, res.balances);
        await chrome.storage.local.set({ [BALANCES_CACHE_KEY]: { balances: res.balances, at: Date.now() } });
        return { balances: res.balances, cached: false };
      }
      // Scan failed (offline / locked) — fall back to the last cached snapshot (cached-first).
      if (prevCache && prevCache.balances) return { balances: prevCache.balances, cached: true };
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'balance scan failed' };
    }
    case ACTIONS.prepareSend: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      // Forward assetId (#121): the vault decides native-XCH vs CAT purely from it; dropping it
      // silently sent a selected token as native XCH. The mapping is a pure, unit-tested helper.
      // Sends spend FROM the active index (#165); change returns to it (sendFlow.ts).
      return callVault({ ...prepareSendVaultRequest(message, coinsetUrl), activeIndex: await activeDerivationIndex() });
    }
    case ACTIONS.confirmSend: {
      // The ONLY place a real spend is broadcast — reached only after the user approves in the UI.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        // #154 — only a REAL send has a counterparty; split/combine (self-only) reuse this exact same
        // path and must NOT be logged as "sent" (nothing was sent to anyone).
        // #152 — a send-with-clawback carries its locked-coin params onto the logged 'sent' entry so
        // the Clawback panel can later list it as a pending OUTGOING candidate.
        if (res.activityHint?.counterparty) await logActivity('sent', res.activityHint, res.spentCoinId, { clawback: res.clawbackInfo });
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'send failed' };
    }
    case ACTIONS.sendStatus: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'sendStatus', coinId: message.coinId, coinsetUrl });
      // #154 — the confirm-poll is the ONLY signal that flips a logged entry pending → confirmed.
      if (res && res.confirmed === true) await confirmActivity(message.coinId);
      return res;
    }
    case ACTIONS.getActivity: {
      // #217 — when the resolved source is a node, show the node's confirmed on-chain history
      // (get_transactions, block-time). Else the local activity log (#154): an instant storage read
      // for the ACTIVE wallet + active index (#165), NOT an on-chain scan. See src/lib/activity-log.ts.
      const nodeAct = await readFromNodeSource((c) => c.getActivity());
      if (nodeAct.handled) return nodeAct.result;
      const state = await loadRegistry();
      if (!state.activeId) return { events: [] };
      const index = await activeDerivationIndex();
      return { events: entriesFor(await readActivityLogState(), state.activeId, index) };
    }
    case ACTIONS.makeOffer: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'makeOffer', offered: message.offered, requested: message.requested, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
      // #101 — persist the made offer to the local "your offers" log the moment it's built (there is
      // no broadcast to hang this on — an offer is only a promise until someone takes it).
      if (res && res.success !== false && res.offer) {
        await recordOffer(res.offer, res.offerSummary, res.offerCoinIds?.[0]);
      }
      return res;
    }
    case ACTIONS.inspectOffer: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'inspectOffer', offerStr: message.offerStr, coinsetUrl });
    }
    case ACTIONS.prepareTrade: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareTrade', offerStr: message.offerStr, tradeKind: message.tradeKind, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmTrade: {
      // The ONLY place a prepared trade is broadcast — reached only after the user approves in the UI.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmTrade', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('trade', res.activityHint, res.spentCoinId);
        // #101 — a CANCEL of an offer THIS wallet made: flip its log entry eagerly (never let the
        // next getOffers poll guess it was `taken` by someone else).
        if (res.tradeKind === 'cancel') await markOfferCancelled(res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'trade failed' };
    }
    case ACTIONS.getOffers: {
      // #101 — the local "your offers" log for the ACTIVE wallet + active index (#165), reconciled
      // against the chain for any still-`open` entry. See src/lib/offer-log.ts.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return { offers: await listOffersReconciled(coinsetUrl) };
    }
    case ACTIONS.listNfts: {
      // #217 — node-first: the dig-node's get_nfts when a node source is active; else the vault scan.
      const nodeNfts = await readFromNodeSource((c) => c.getNfts());
      if (nodeNfts.handled) return nodeNfts.result;
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'listNfts', activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.prepareNftTransfer: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftTransfer', launcherId: message.launcherId, recipient: message.recipient, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftTransfer: {
      // The ONLY place a prepared NFT transfer is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('sent', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft transfer failed' };
    }
    case ACTIONS.prepareNftBulkTransfer: {
      // Build (not broadcast) a bulk transfer of the selected NFTs (#171) — held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftBulkTransfer', launcherIds: message.launcherIds, recipient: message.recipient, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftBulkTransfer: {
      // The ONLY place a prepared bulk NFT transfer is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('sent', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft bulk transfer failed' };
    }
    case ACTIONS.prepareNftBulkBurn: {
      // Build (not broadcast) a bulk burn of the selected NFTs (#171) — held for approval. Building
      // the spend is NOT destructive by itself; only confirmNftBulkBurn (below) actually broadcasts.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftBulkBurn', launcherIds: message.launcherIds, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftBulkBurn: {
      // The ONLY place a prepared bulk NFT burn is broadcast — IRREVERSIBLE. The UI is responsible
      // for having already obtained the user's explicit, distinct destructive confirmation before
      // ever sending this action; the SW does not re-confirm, it only executes + logs.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('burn', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft bulk burn failed' };
    }
    case ACTIONS.prepareNftMint: {
      // Build (not broadcast) a new-NFT mint (#92): CHIP-0007 metadata + royalty; held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftMint', nftMint: message.nftMint, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftMint: {
      // The ONLY place a prepared NFT mint is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('mint', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft mint failed' };
    }
    case ACTIONS.prepareCatIssuance: {
      // Build (not broadcast) a brand-new CAT issuance (#97): single fixed-supply or multi
      // signature-gated TAIL; held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareCatIssuance', catIssuance: message.catIssuance, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmCatIssuance: {
      // The ONLY place a prepared CAT issuance is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('mint', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'cat issuance failed' };
    }
    case ACTIONS.prepareOptionMint: {
      // Build (not broadcast) a new XCH-denominated option mint (#104): writer AND initial holder;
      // held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareOptionMint', optionMint: message.optionMint, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmOptionMint: {
      // The ONLY place a prepared option mint is broadcast — reuses the vault confirmSend path.
      // Records the FULL terms into the local option registry (#104) as a side effect — a bare
      // on-chain option carries no recoverable terms.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('mint', res.activityHint, res.spentCoinId);
        if (message.optionRecord) await recordOption(message.optionRecord);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'option mint failed' };
    }
    case ACTIONS.prepareOptionExercise: {
      // Build (not broadcast) the exercise of an option this wallet holds (#104); held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareOptionExercise', optionRecord: message.optionRecord, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmOptionExercise: {
      // The ONLY place a prepared option exercise is broadcast — reuses the vault confirmSend path.
      // Eagerly flips the local registry entry to 'exercised' (#104) — melting is a self-inflicted
      // action the SW already knows about, no need to wait for the next getOptions poll.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('melt', res.activityHint, res.spentCoinId);
        await markOptionExercised(res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'option exercise failed' };
    }
    case ACTIONS.getOptions: {
      // #104 — the local option registry for the ACTIVE wallet + active index (#165), reconciled
      // against the chain for any still-`open` entry. See src/lib/optionContractLog.ts.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return { options: await listOptionsReconciled(coinsetUrl) };
    }
    case ACTIONS.listDids: {
      // #217 — node-first: the dig-node's get_dids when a node source is active; else the vault scan.
      const nodeDids = await readFromNodeSource((c) => c.getDids());
      if (nodeDids.handled) return nodeDids.result;
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'listDids', activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.prepareDidCreate: {
      // Build (not broadcast) a new "simple" DID (#93); held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareDidCreate', fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmDidCreate: {
      // The ONLY place a prepared DID create is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('did', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'did create failed' };
    }
    case ACTIONS.prepareDidTransfer: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareDidTransfer', launcherId: message.launcherId, recipient: message.recipient, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmDidTransfer: {
      // The ONLY place a prepared DID transfer is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('did', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'did transfer failed' };
    }
    case ACTIONS.prepareDidProfileUpdate: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareDidProfileUpdate', launcherId: message.launcherId, profileName: message.profileName, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmDidProfileUpdate: {
      // The ONLY place a prepared DID profile update is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('did', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'did profile update failed' };
    }
    case ACTIONS.prepareNftDidAssign: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftDidAssign', launcherId: message.launcherId, didLauncherId: message.didLauncherId, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftDidAssign: {
      // The ONLY place a prepared NFT↔DID assignment is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('did', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft did assign failed' };
    }
    case ACTIONS.prepareNftBulkDidAssign: {
      // Build (not broadcast) a bulk NFT↔DID assignment over the selected set (#99) — held for approval.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareNftBulkDidAssign', launcherIds: message.launcherIds, didLauncherId: message.didLauncherId, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.confirmNftBulkDidAssign: {
      // The ONLY place a prepared bulk NFT↔DID assignment is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        await logActivity('did', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'nft bulk did assign failed' };
    }
    case ACTIONS.listCoins: {
      // #217 — node-first: the dig-node's get_coins when a node source is active; else the vault scan.
      const nodeCoins = await readFromNodeSource((c) => c.getCoins(message.assetId));
      if (nodeCoins.handled) return nodeCoins.result;
      // Read-only per-asset coin listing (coin control #91). Routed on assetId (#121).
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'listCoins', assetId: message.assetId, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.prepareSplit: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareSplit', assetId: message.assetId, coinIds: message.coinIds, outputs: message.outputs, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.prepareCombine: {
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareCombine', assetId: message.assetId, coinIds: message.coinIds, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.prepareConsolidation: {
      // #417 — build the auto-consolidation (merge the smallest up-to-cap coins) so a fragmented
      // wallet can fund a spend the coin-count cap rejected. Vault→coinset like prepareCombine
      // (the spend path is deliberately independent of the node wallet-source, #399/#407/#217).
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({ op: 'prepareConsolidation', assetId: message.assetId, fee: message.fee, activeIndex: await activeDerivationIndex(), coinsetUrl });
    }
    case ACTIONS.listClawbacks: {
      // Read-only (#152): INCOMING is discovered on chain by hint at the active index; OUTGOING
      // candidates come from this wallet+index's OWN local activity log — the vault has no other way
      // to enumerate a wallet's past clawback sends (each 'sent' entry that used a clawback window
      // carries its locked-coin params, see logActivity's `extra.clawback`).
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const state = await loadRegistry();
      const index = await activeDerivationIndex();
      const entries = state.activeId ? entriesFor(await readActivityLogState(), state.activeId, index) : [];
      const clawbackCandidates = entries.filter((e) => e.kind === 'sent' && e.clawback).map((e) => e.clawback);
      return callVault({ op: 'listClawbacks', clawbackCandidates, activeIndex: index, coinsetUrl });
    }
    case ACTIONS.prepareClawbackAction: {
      // Build (not broadcast) the CLAIM (receiver) / CLAW BACK (sender) spend for one pending
      // clawback (#152); held for approval. Broadcast via confirmClawbackAction.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      return callVault({
        op: 'prepareClawbackAction',
        direction: message.direction,
        clawbackInfo: message.clawbackInfo,
        fee: message.fee,
        activeIndex: await activeDerivationIndex(),
        coinsetUrl,
      });
    }
    case ACTIONS.confirmClawbackAction: {
      // The ONLY place a prepared clawback claim/claw-back is broadcast — reuses the vault confirmSend path.
      const coinsetUrl = resolveCoinsetUrl(await readWalletSettings());
      const res = await callVault({ op: 'confirmSend', pendingId: message.pendingId, coinsetUrl });
      if (res && res.success !== false) {
        try { await chrome.storage.local.remove(BALANCES_CACHE_KEY); } catch { /* ignore */ }
        // #154 — a claim/claw-back moves funds to the actor's OWN address; logged as kind 'clawback'
        // regardless of direction (the "Clawed back {amount} {ticker}" copy fits both — the funds
        // return to this wallet's own custody either way).
        await logActivity('clawback', res.activityHint, res.spentCoinId);
      }
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'clawback action failed' };
    }
    default:
      return { success: false, code: 'CUSTODY_ERROR', message: 'unknown custody action' };
  }
}

// NFT collection metadata + richer gallery (#98): a CHIP-0007 off-chain document is always small.
const NFT_METADATA_MAX_BYTES = 200 * 1024; // 200 KB
const NFT_METADATA_TIMEOUT_MS = 8000;

/**
 * Fetch + JSON-decode the off-chain CHIP-0007 metadata document at `uri` (#98). Handled HERE — in
 * the service worker itself, not the offscreen vault/document — as a simple, no-vault-dependency
 * read, matching the other non-custody SW actions (`getDigDnsStatus`, `getVerification`, …).
 *
 * `metadataUris` are arbitrary third-party hosts (IPFS gateways, marketplace CDNs) the extension
 * cannot enumerate in advance. **A real gotcha, found empirically (`DEVELOPMENT_LOG.md`):** it was
 * assumed a Manifest V3 background service worker's own `fetch()` is NOT subject to the
 * extension-pages CSP `connect-src` directive (that directive's name suggests it governs only
 * extension HTML documents — popup/options/offscreen). That assumption was WRONG in practice: a
 * `getNftMetadata` call to a host outside `connect-src` failed with a network error and the request
 * never even reached the network layer — the signature of a CSP block. `connect-src` (and
 * `host_permissions`, for the extension's CORS-bypass fetch elevation — most off-chain metadata
 * hosts won't send `Access-Control-Allow-Origin`) had to be widened to `https:` / an all-hosts
 * pattern (`manifest.json`), matching the breadth `img-src` already grants NFT art (§18.11 SPEC.md).
 *
 * GET-only, time-capped, and rejects an oversized response before ever attempting to parse it.
 * Returns the RAW decoded JSON — the caller (`parseNftOffchainMetadata`,
 * `src/lib/nft-offchain-metadata.ts`) validates/shapes it, since this is untrusted third-party
 * content, not something this handler should interpret.
 */
async function fetchNftMetadataJson(uri) {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) {
    return { success: false, code: 'BAD_REQUEST', message: 'metadata uri must be http(s)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NFT_METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { signal: controller.signal });
    if (!res.ok) return { success: false, code: 'FETCH_FAILED', message: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length > NFT_METADATA_MAX_BYTES) {
      return { success: false, code: 'TOO_LARGE', message: 'metadata document too large' };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { success: false, code: 'INVALID_JSON', message: 'not valid JSON' };
    }
    return { metadata: json };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { success: false, code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', message: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── dexie marketplace integration (#102) — SW-side glue over the pure lib/dexie.ts client ───────
// NOT custody actions (no wallet key involved): posting an already-built offer, browsing dexie's
// public listing, and resolving a dexie link/id are all plain fetches, handled directly here
// exactly like fetchNftMetadataJson above (`api.dexie.space` is pre-granted in both
// `host_permissions` and the extension-pages CSP `connect-src`, confirmed live).

async function handleDexiePost(offer) {
  if (typeof offer !== 'string' || !offer.startsWith('offer1')) {
    return { success: false, code: 'BAD_REQUEST', message: 'offer string required' };
  }
  try {
    const { id, known } = await postOfferToDexie(fetch, offer);
    return { success: true, dexieId: id, known };
  } catch (e) {
    const msg = e && e.message ? e.message : 'dexie post failed';
    const codeMatch = /^([A-Z][A-Z0-9_]*):/.exec(msg);
    return { success: false, code: codeMatch ? codeMatch[1] : 'DEXIE_POST_FAILED', message: msg };
  }
}

async function handleDexieBrowse(offered, requested) {
  const offers = await searchDexieOffers(fetch, {
    ...(offered ? { offered } : {}),
    ...(requested ? { requested } : {}),
  });
  return { offers };
}

async function handleDexieResolve(idOrUrl) {
  if (typeof idOrUrl !== 'string' || idOrUrl.length === 0) {
    return { success: false, code: 'BAD_REQUEST', message: 'idOrUrl required' };
  }
  const offer = await fetchDexieOffer(fetch, idOrUrl);
  return { offer };
}

// Auto-lock: TTL sweep (alarm) + OS idle/lock → drop the key from the vault.
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === AUTO_LOCK_ALARM) {
      (async () => {
        const sess = await chrome.storage.session.get(UNLOCK_EXPIRY_KEY);
        const expiry = sess[UNLOCK_EXPIRY_KEY];
        if (!expiry || Date.now() >= expiry) await lockVaultNow();
      })();
    }
  });
} catch { /* alarms unavailable */ }
try {
  // #76 — explicit, not Chrome's undocumented-by-default detection window: a real, in-between idle
  // check needs a granularity comparable to the 1-minute TTL sweep above, so a genuinely-idle user
  // is caught promptly without a coarser interval leaving the wallet unlocked for a visibly stale
  // stretch. 60s is also the Chrome-enforced floor's most permissive common value across platforms.
  chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL_SECONDS);
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'idle' || state === 'locked') lockVaultNow();
  });
} catch { /* idle unavailable */ }

/**
 * #76 — lock-on-suspend/wake: recompute the lock snapshot immediately whenever this module
 * (re)runs, rather than waiting for the next AUTO_LOCK_ALARM tick (up to a minute away) or an
 * OS idle/locked event. An MV3 service worker is torn down and respawned around OS sleep, browser
 * restart, and ordinary SW eviction — every one of those re-executes this top-level module code, so
 * a single call here is the earliest possible point to notice "the TTL lapsed while nothing was
 * running" and tidy up the vault + the stale alarm. A snapshot that is still fresh is a harmless
 * no-op (lockVaultNow is idempotent).
 */
async function checkAutoLockOnWake() {
  try {
    const snap = await getLockStateSnapshot();
    if (snap.lockState === LOCK_STATE.LOCKED) await lockVaultNow();
  } catch { /* best effort — the periodic alarm + idle listener still cover this */ }
}
void checkAutoLockOnWake();
chrome.runtime.onStartup.addListener(() => { void checkAutoLockOnWake(); });

// ─── dApp `walletRpc` approval window (#56 §5.5) ───────────────────────────────────────────────
// A dedicated, trusted popup window the SW summons when a dApp asks the custody wallet to sign. It
// is NOT the main wallet (that needs a user gesture via action.openPopup); chrome.windows.create
// works from the background. The window reads the pending queue (dappApprovalList) + returns the
// user's decision (dappApprovalResolve); a keepalive port keeps the SW + offscreen vault alive.
const APPROVAL_URL = 'approval.html';
let approvalWindowId = null;

/** Open the approval window (or focus it if already open). */
async function summonApprovalWindow() {
  if (approvalWindowId != null) {
    try { await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true }); return; } catch { approvalWindowId = null; }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(APPROVAL_URL),
      type: 'popup',
      width: 460,
      height: 680,
      focused: true,
    });
    approvalWindowId = win && win.id != null ? win.id : null;
  } catch { /* windows API unavailable (e.g. under test) */ }
}

try {
  chrome.windows.onRemoved.addListener((winId) => {
    if (winId === approvalWindowId) approvalWindowId = null;
  });
} catch { /* windows API unavailable */ }

// ─── Phishing blocklist (#67 P0-2) ─────────────────────────────────────────────────────────────
// Load the refreshed DIG-curated blocklist from storage (the bundled seed is unioned in assessOrigin).
async function loadBlocklistDomains() {
  try {
    const out = await chrome.storage.local.get(PHISHING_BLOCKLIST_KEY);
    const rec = out[PHISHING_BLOCKLIST_KEY];
    return rec && Array.isArray(rec.domains) ? rec.domains : [];
  } catch { return []; }
}
// Assess an origin against the current (seed ∪ refreshed) blocklist + DIG-lookalike heuristics.
async function assessOriginNow(origin) {
  return assessOrigin(origin, await loadBlocklistDomains());
}
// Best-effort refresh of the DIG-curated blocklist. A failed/absent endpoint keeps the last list
// (never wipes a good list with an empty payload). Called on startup + on an interval alarm.
async function refreshPhishingBlocklist() {
  try {
    const res = await fetch(DEFAULT_BLOCKLIST_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const domains = parseBlocklistPayload(await res.json());
    if (domains.length > 0) {
      await chrome.storage.local.set({ [PHISHING_BLOCKLIST_KEY]: { domains, fetchedAt: Date.now() } });
    }
  } catch { /* best-effort; keep the last-known list */ }
}
const PHISHING_REFRESH_ALARM = 'phishing-refresh';
try {
  chrome.alarms.create(PHISHING_REFRESH_ALARM, { periodInMinutes: Math.max(1, Math.round(BLOCKLIST_REFRESH_MS / 60000)) });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === PHISHING_REFRESH_ALARM) refreshPhishingBlocklist();
  });
} catch { /* alarms unavailable */ }
refreshPhishingBlocklist();

// The SW-side router + queue. Consent, the offscreen vault, and the window summon are injected so
// the module stays chrome-free + unit-tested (dapp-approval.test.mjs).
const dappApproval = new DappApprovalManager({
  isOriginApproved: (o) => isOriginApproved(chrome.storage.local, o),
  recordPendingOrigin: (o) => recordPendingOrigin(o),
  // Attach the resolved coinset endpoint + the CURRENT active derivation index (#165) to EVERY dApp
  // vault call, read fresh on each call (never captured once at construction) — the user may
  // navigate the active index via prev/next while the SW is alive, and a dApp request must always
  // operate on whichever index is active AT CALL TIME, not whatever was active when the SW booted.
  //
  // #76 — a fresh lock-state check gates EVERY call, not just the periodic AUTO_LOCK_ALARM sweep or
  // the chrome.idle listener: a queued dApp request can sit in the approval window for a long time
  // (a keepalive port keeps the SW alive throughout, on purpose, so review isn't rushed), and the
  // TTL may lapse WHILE it waits — up to a minute before the next alarm tick would otherwise notice.
  // Checking here means the session can never outlive its TTL just because an approval window held
  // it open; a lapsed session is refused (and the vault tidied up) at the moment of use, not on the
  // alarm's schedule. `getLockStateSnapshot` recomputes freshly from storage every call — it is NOT
  // reading a value cached from when the request was first queued.
  callVault: async (req) => {
    const snap = await getLockStateSnapshot();
    if (snap.lockState !== LOCK_STATE.UNLOCKED) {
      await lockVaultNow();
      return { success: false, code: 'LOCKED', message: 'wallet session expired — unlock the wallet to continue' };
    }
    return callVault({ ...req, coinsetUrl: resolveCoinsetUrl(await readWalletSettings()), activeIndex: await activeDerivationIndex() });
  },
  summonWindow: () => summonApprovalWindow(),
  assessOrigin: (o) => assessOriginNow(o),
  randomId: () => crypto.randomUUID(),
});

// Keepalive port from the approval window: while it is connected (and pinging), the MV3 service
// worker is kept alive so the pending sign request + the offscreen vault survive the review. No
// state is torn down on disconnect — the queued request resolves via its own promise on decision.
try {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'dapp-approval-keepalive') return;
    const onMsg = () => { try { port.postMessage({ alive: true }); } catch { /* port closing */ } };
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(() => { try { port.onMessage.removeListener(onMsg); } catch { /* ignore */ } });
  });
} catch { /* onConnect unavailable */ }

// Listen for messages from content script to proxy requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages the SW forwards to the offscreen vault are handled by the offscreen document, not here.
  if (message && message.target === OFFSCREEN_TARGET) return false;
  // Self-custody keystore ops (#56) → coordinate the offscreen vault + storage + unlock window.
  if (message && isCustodyAction(message.action)) {
    (async () => {
      try { sendResponse(await handleCustodyAction(message)); }
      catch { try { sendResponse({ success: false, code: 'CUSTODY_ERROR', message: 'custody op failed' }); } catch { /* port closed */ } }
    })();
    return true; // async
  }
  // NFT collection metadata + richer gallery (#98) — see fetchNftMetadataJson's doc comment for why
  // this is NOT a custody action (no vault/session involvement) and is handled directly here.
  if (message.action === ACTIONS.getNftMetadata) {
    (async () => {
      sendResponse(await fetchNftMetadataJson(message.uri));
    })();
    return true; // async
  }
  // dexie marketplace integration (#102) — see handleDexiePost/Browse/Resolve's doc comments for why
  // these are NOT custody actions (no wallet key involved).
  if (message.action === ACTIONS.dexiePost) {
    (async () => { sendResponse(await handleDexiePost(message.offer)); })();
    return true; // async
  }
  if (message.action === ACTIONS.dexieBrowse) {
    (async () => { sendResponse(await handleDexieBrowse(message.offered, message.requested)); })();
    return true; // async
  }
  if (message.action === ACTIONS.dexieResolve) {
    (async () => { sendResponse(await handleDexieResolve(message.idOrUrl)); })();
    return true; // async
  }
  if (message.action === 'toggleExtension') {
    // State is updated in the React popup; no redirect rules to update (all content via RPC)
    console.log('Extension toggled:', message.enabled);
    return false; // Not async
  }

  if (message.action === ACTIONS.appViewFraming) {
    // In-window app-view (#66): install/remove the EPHEMERAL declarativeNetRequest session rule that
    // strips *.on.dig.net's framing headers so the app-view iframe can embed a DIG dApp. Scope to the
    // sender's tab when it has one (the expanded/app.html layout) so the strip is pinned to that tab.
    (async () => {
      try {
        if (message.enable) {
          const rule = buildFramingBypassRule(sender?.tab?.id);
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [APPVIEW_FRAMING_RULE_ID],
            addRules: [rule],
          });
        } else {
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [APPVIEW_FRAMING_RULE_ID] });
        }
        sendResponse({ success: true });
      } catch (e) {
        console.error('DIG Extension: appViewFraming rule update failed:', e);
        try { sendResponse({ success: false }); } catch { /* port closed */ }
      }
    })();
    return true; // async
  }

  if (message.action === 'convertDigUrl') {
    // Convert chia:// URL to data URL via RPC
    (async () => {
      try {
        const digUrl = message.url;
        if (!digUrl || !digUrl.startsWith('chia://')) {
          sendResponse({ ...makeError('Invalid chia:// URL', DIG_ERR.DIG_ERR_INVALID_URN), error: 'Invalid chia:// URL' });
          return;
        }

        // Use RPC to get data URL
        const rpcResult = await fetchContentViaRPC(digUrl);
        sendResponse({ url: rpcResult.dataUrl, dataUrl: rpcResult.dataUrl });
      } catch (error) {
        console.error('DIG Extension: Error converting URL via RPC:', error);
        // Coded envelope: stable DIG_ERR_* code + the original human message.
        sendResponse({ ...makeError(error), error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'navigateDigInput') {
    // #362 — classify + resolve + navigate ANY raw entry input against the sender (or active) tab.
    (async () => {
      try {
        let tabId = sender.tab ? sender.tab.id : null;
        if (!tabId) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs.length === 0) {
            try { sendResponse({ error: 'No active tab found' }); } catch { /* port closed */ }
            return;
          }
          tabId = tabs[0].id;
        }
        await handleResolvedNavigation(tabId, message.input);
        try { sendResponse({ success: true }); } catch { /* port closed by navigation, expected */ }
      } catch (error) {
        try { sendResponse({ error: error.message }); } catch { /* port closed */ }
      }
    })();
    return true; // keep the channel open for the async response
  }

  if (message.action === 'navigateToDigUrl') {
    // Convert chia:// URL to server URL (subdomain format) and navigate tab
    // IMPORTANT: Must return true immediately to keep channel open, then call sendResponse in async
    const handleNavigateToDigUrl = async () => {
      try {
        const digUrl = message.url;
        let tabId = sender.tab ? sender.tab.id : null;
        
        if (!tabId) {
          // Fallback: try to get active tab
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs.length === 0) {
            try {
              sendResponse({ error: 'No active tab found' });
            } catch (e) {
              console.error('DIG Extension: Failed to send response (port closed):', e);
            }
            return;
          }
          tabId = tabs[0].id;
        }
        
        console.log('DIG Extension: navigateToDigUrl requested for:', digUrl);
        console.log('DIG Extension: Tab ID:', tabId);
        
        // Redirect to dig-viewer.html (not data URL)
        await handleDigUrlNavigation(tabId, digUrl);
        
        console.log('DIG Extension: Successfully redirected to viewer');
        
        // Try to send response (may fail if navigation closed port)
        try {
          const urn = digUrl.replace(/^chia:\/\//, '');
          const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
          sendResponse({ success: true, url: viewerUrl });
        } catch (e) {
          // Port may be closed due to navigation - this is expected
          console.log('DIG Extension: Response not sent (port closed by navigation, expected)');
        }
      } catch (error) {
        console.error('DIG Extension: Error in navigateToDigUrl:', error);
        try {
          sendResponse({ error: error.message });
        } catch (e) {
          console.error('DIG Extension: Failed to send error response (port closed):', e);
        }
      }
    };
    
    // Start async handler immediately
    handleNavigateToDigUrl();
    
    // Return true to keep channel open for async response
    return true;
  }
  
  if (message.action === 'navigateToDataUrl') {
    // Deprecated: Navigate to server URL instead of data URL
    // Get tab ID from sender (more reliable than querying)
    const tabId = sender.tab ? sender.tab.id : null;
    const dataUrl = message.dataUrl;
    
    // If it's actually a data URL, we can't navigate to it (browser restriction)
    // But if it's a server URL (legacy call), navigate to it
    if (dataUrl && !dataUrl.startsWith('data:')) {
      if (!tabId) {
        // Fallback: try to get active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            console.log('DIG Extension: Navigating tab', tabs[0].id, 'to server URL');
            chrome.tabs.update(tabs[0].id, { url: dataUrl });
          } else {
            console.error('DIG Extension: No active tab found for navigation');
          }
        });
        return false;
      }
      
      console.log('DIG Extension: Navigating tab', tabId, 'to server URL');
      chrome.tabs.update(tabId, { url: dataUrl }).catch(error => {
        console.error('DIG Extension: Error navigating to server URL:', error);
      });
    } else {
      console.warn('DIG Extension: navigateToDataUrl called with data URL (deprecated, use navigateToDigUrl instead)');
    }
    
    // Return false since we're not sending a response (navigation closes the port)
    return false;
  }
  
  if (message.action === 'getDataUrl') {
    // Deprecated: Return server URL instead of data URL
    // IMPORTANT: Must return true immediately to keep channel open, then call sendResponse in async
    const handleGetDataUrl = async () => {
      try {
        const digUrl = message.url;
        console.log('DIG Extension: getDataUrl requested (returning data URL from RPC):', digUrl);
        
        // Use RPC to get data URL
        const rpcResult = await fetchContentViaRPC(digUrl);
        const dataUrl = rpcResult.dataUrl;
        console.log('DIG Extension: Got data URL from RPC');
        
        // Return data URL
        try {
          sendResponse({ dataUrl: dataUrl, url: dataUrl });
        } catch (e) {
          console.error('DIG Extension: Failed to send response (port may be closed):', e);
        }
      } catch (error) {
        console.error('DIG Extension: Error getting data URL from RPC:', error);
        try {
          // Coded envelope: stable DIG_ERR_* code + the original human message.
          sendResponse({ ...makeError(error), error: error.message });
        } catch (e) {
          console.error('DIG Extension: Failed to send error response (port closed):', e);
        }
      }
    };
    
    // Start async handler immediately
    handleGetDataUrl();
    
    // Return true to keep channel open for async response
    return true;
  }
  
  if (message.action === 'updateServerConfig') {
    // Server configuration updated - save immediately
    console.log('Server config updated:', message.host || `${message.url}:${message.port}`);
    
    // Save in new format if provided
    const storageData = {};
    if (message.host) {
      storageData['server.host'] = message.host;
      // Also parse and save in old format for backward compatibility
      const config = parseServerHost(message.host);
      storageData['server.url'] = config.url;
      storageData['server.port'] = config.port;
    } else {
      // Old format - save both
      storageData['server.url'] = message.url || DEFAULT_SERVER_URL;
      storageData['server.port'] = message.port || DEFAULT_SERVER_PORT;
      storageData['server.host'] = `${storageData['server.url']}:${storageData['server.port']}`;
    }
    
    chrome.storage.local.set(storageData).then(() => {
      console.log('DIG Extension: RPC host updated to:', storageData['server.host']);

      // Notify all tabs to update their RPC host cache
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id && chrome.tabs && chrome.tabs.sendMessage) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'updateRpcHost',
              rpcHost: storageData['server.host']
            }).catch(() => {
              // Ignore errors (tab might not have content script loaded)
            });
          }
        });
      });
    });
    
    return false; // Not async
  }
  
  if (message.action === 'reportError') {
    // Store error report
    errorReports.push({
      url: message.url,
      error: message.error,
      strategy: message.strategy,
      timestamp: message.timestamp
    });
    // Keep only last 100 errors
    if (errorReports.length > 100) {
      errorReports.shift();
    }
    return false;
  }
  
  if (message.action === 'reportSuccess') {
    // Store success report
    successReports.push({
      url: message.url,
      strategy: message.strategy,
      timestamp: message.timestamp
    });
    // Keep only last 1000 successes
    if (successReports.length > 1000) {
      successReports.shift();
    }
    return false;
  }
  
  if (message.action === 'navigate') {
    // Navigate the current tab to a URL (used for programmatic navigation)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: message.url });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    });
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'proxyRequest') {
    // Proxy a chia:// request through the background service worker. Every call re-fetches,
    // re-verifies, and re-decrypts — the extension does NOT cache resolved content (caching is
    // a dig-node job; see #43 / #41 SoC audit decision 3).
    const digUrl = message.url;
    if (!digUrl || !digUrl.startsWith('chia://')) {
      // Coded envelope: keep the friendly message for humans, add a stable machine code.
      sendResponse({ ...makeError('Invalid chia:// URL', DIG_ERR.DIG_ERR_INVALID_URN), error: 'Invalid chia:// URL' });
      return false;
    }

    (async () => {
      const endpoint = await getRpcEndpoint();
      try {
        // Parse URN to determine if we should use RPC
        const urnString = digUrl.replace(/^chia:\/\//, '');
        const parsed = parseURN(urnString);

        if (parsed) {
          // Valid URN - use RPC (pass resolved endpoint to avoid second resolution)
          console.log('DIG Extension: Fetching via RPC for URN:', urnString.substring(0, 50) + '...');
          const rpcResult = await fetchContentViaRPC(digUrl, endpoint);

          // RPC returns data URL directly
          const dataUrl = rpcResult.dataUrl;

          // Extract content type from data URL
          const contentTypeMatch = dataUrl.match(/^data:([^;]+)/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';

          sendResponse({
            success: true,
            data: dataUrl,
            contentType: contentType,
            verified: !!rpcResult.verified
          });
          return;
        }

        // Not a valid URN - still try RPC (RPC server will return decoy or error)
        console.log('DIG Extension: Invalid URN format, trying RPC anyway:', digUrl);
        try {
          const rpcResult = await fetchContentViaRPC(digUrl, endpoint);
          const dataUrl = rpcResult.dataUrl;
          const contentTypeMatch = dataUrl.match(/^data:([^;]+)/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';

          sendResponse({
            success: true,
            data: dataUrl,
            contentType: contentType
          });
          return;
        } catch (rpcError) {
          console.error('DIG Extension: RPC failed for invalid URN:', rpcError);
          // Coded envelope: classify the underlying failure; keep human prose in `error`.
          const env = makeError(rpcError);
          sendResponse({ ...env, error: `Invalid URN format: ${rpcError.message}` });
          return;
        }
      } catch (error) {
        console.error('DIG Extension: Proxy request failed:', error);
        // Coded envelope: stable DIG_ERR_* code + the original human message.
        sendResponse({ ...makeError(error), error: error.message });
      }
    })();

    return true; // Keep channel open for async response
  }

  // window.chia RPC from the content-script bridge (DIG_WALLET_REQUEST). The committed page origin
  // is supplied by the content script. Returns the {status, body} envelope the provider expects.
  // NOTE: sender.origin (when present) is the unspoofable origin; we prefer it over the
  // message-supplied origin so a compromised content script can't lie.
  //
  // Routing (§5.5): every window.chia request routes to the SELF-CUSTODY dApp manager — connect +
  // reads go straight to the offscreen vault, and sign/message requests are enqueued + summon the
  // approval window (the promise stays pending until the user decides). A blocklisted origin is
  // refused inside route() (#67 P0-2 phishing gate). There is NO WalletConnect/Sage fallback: the
  // extension IS the wallet, so a request with no/locked wallet resolves to 202 (pending, awaiting
  // approval) or a locked-class error, prompting the user to create/unlock a wallet in the extension.
  if (message.action === 'walletRpc') {
    const origin = (sender && sender.origin) || message.origin;
    (async () => {
      let env;
      try {
        // Permission management (#67 P0-4): wallet_getPermissions / wallet_revokePermissions are
        // answered from the shared per-origin consent store.
        if (isPermissionMethod(message.method)) {
          env = await handlePermissionMethod(chrome.storage.local, message.method, origin);
          try { sendResponse(env); } catch { /* port closed */ }
          return;
        }
        env = await dappApproval.route({ method: message.method, params: message.params || {}, origin });
      } catch (e) {
        env = { status: 500, body: { error: (e && e.message) || 'wallet request failed' } };
      }
      // Connected-sites bookkeeping (#67 P0-4): on a served request from an approved origin, record
      // lastUsed + the invoked method (and the address on connect). Best-effort; no-op if not approved.
      if (origin && env && env.status === 200) {
        const isConnect = /(^|_)connect$/i.test(String(message.method || ''));
        const data = env.body && env.body.data;
        const address = isConnect && data && typeof data === 'object' ? data.address : undefined;
        noteOriginUsage(chrome.storage.local, origin, { method: message.method, address }).catch(() => {});
      }
      try { sendResponse(env); } catch { /* port closed */ }
    })();
    return true; // async
  }

  // Approval window (§5.5) → SW: read the pending dApp signing-request queue, each enriched with the
  // tamper-resistant summary decoded FROM THE BUILT SPEND (via the offscreen vault), plus lock state.
  if (message.action === ACTIONS.dappApprovalList) {
    (async () => {
      try {
        // Fire the summary builds WITHOUT awaiting: a send/offer build scans the chain, so awaiting it
        // would freeze the window on a slow/unreachable coinset. Summaries stream in on later polls.
        void dappApproval.enrich();
        const lock = await getLockStateSnapshot();
        sendResponse({ requests: dappApproval.list(), lockState: lock.lockState, summoned: approvalWindowId != null });
      } catch { try { sendResponse({ requests: [], lockState: 'none', summoned: false }); } catch { /* port closed */ } }
    })();
    return true; // async
  }

  // Approval window (§5.5) → SW: the user's approve/reject decision for one queued request. Approve
  // signs in the offscreen vault + resolves the dApp promise; reject resolves it with an error.
  if (message.action === ACTIONS.dappApprovalResolve) {
    (async () => {
      try { sendResponse(await dappApproval.resolve(message.id, !!message.approved)); }
      catch { try { sendResponse({ success: false, code: 'RESOLVE_FAILED', remaining: dappApproval.size() }); } catch { /* port closed */ } }
    })();
    return true; // async
  }

  // Connected sites (#67 P0-4) → SW: list every origin the wallet is connected to, as capability
  // records (addresses/methods/grantedAt/lastUsed) for the Settings/Advanced Connected-sites screen.
  if (message.action === ACTIONS.listConnectedSites) {
    (async () => {
      try { sendResponse({ sites: await listPermissions(chrome.storage.local) }); }
      catch { try { sendResponse({ success: false, code: 'LIST_FAILED', message: 'could not read connected sites' }); } catch { /* port closed */ } }
    })();
    return true; // async
  }

  // Connected sites (#67 P0-4) → SW: revoke ONE origin's consent (it must re-request to reconnect).
  if (message.action === ACTIONS.revokeConnectedSite) {
    (async () => {
      try { await revokeOrigin(chrome.storage.local, message.origin); sendResponse({ success: true }); }
      catch { try { sendResponse({ success: false, code: 'REVOKE_FAILED', message: 'could not revoke site' }); } catch { /* port closed */ } }
    })();
    return true; // async
  }

  // Connected sites (#67 P0-4) → SW: revoke EVERY connected origin at once.
  if (message.action === ACTIONS.revokeAllConnectedSites) {
    (async () => {
      try { await revokeAllOrigins(chrome.storage.local); sendResponse({ success: true }); }
      catch { try { sendResponse({ success: false, code: 'REVOKE_FAILED', message: 'could not revoke sites' }); } catch { /* port closed */ } }
    })();
    return true; // async
  }

  // dig-viewer reports the Merkle-verification result for the chia:// content it rendered;
  // set the toolbar "Verified" badge + remember per-tab state for the popup.
  if (message.action === 'reportVerification') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    setVerifiedBadge(tabId, message.verified ? 'verified' : 'failed', message.urn);
    return false;
  }

  // Popup asks for the active tab's verification state (to show the Verified line).
  if (message.action === 'getVerification') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0] && tabs[0].id;
        const v = (typeof tabId === 'number' && tabVerification.get(tabId)) || null;
        sendResponse({ verification: v });
      } catch (e) {
        sendResponse({ verification: null });
      }
    })();
    return true;
  }

  // Popup: is a local dig-node reachable? Resolves the dig.local → 127.0.0.1:port try-list
  // and reports the chosen base (or null). Used to show/hide the "install dig-node" prompt.
  if (message.action === 'getDigNodeStatus') {
    (async () => {
      try {
        const base = await resolveLocalDigNode();
        sendResponse({ reachable: !!base, base: base || null });
      } catch {
        sendResponse({ reachable: false, base: null });
      }
    })();
    return true;
  }

  // Wallet-data source auto-detect (#222): the §5.3 ladder status for the WALLET read path
  // (distinct from getDigNodeStatus's content path above) — the selected mode + the resolved
  // source. Backs ChainSourceSetting's "Local dig-node detected" indicator (Auto mode only).
  if (message.action === ACTIONS.getChainSourceStatus) {
    (async () => {
      try {
        const { mode, resolved } = await resolveWalletDataSource();
        sendResponse({ mode, resolved });
      } catch {
        sendResponse({ mode: 'auto', resolved: { kind: 'coinset' } });
      }
    })();
    return true;
  }

  // dig-dns Path-B proxy fallback (#175): the ONE shared `.dig`-resolution availability signal.
  // Serves the cached snapshot unless it is stale (no reader should wait up to the full 2-minute
  // alarm interval for a fresh read — e.g. right after the user just started dig-dns).
  if (message.action === ACTIONS.getDigDnsStatus) {
    (async () => {
      const cached = digDnsController.getSnapshot();
      const snap = shouldRefreshDigDnsSnapshot(cached, Date.now())
        ? await digDnsController.probe().catch(() => cached)
        : cached;
      sendResponse(snap);
    })();
    return true;
  }

  // DIG Shields (#134): the dig-viewer records each resolved resource's inclusion-proof
  // verdict into the active tab's proof ledger so the popup's Shield action can list the
  // per-resource proofs. The verdict is the loader's — this never re-verifies.
  if (message.action === ACTIONS.recordLedgerEntry) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    try {
      if (typeof tabId === 'number') {
        ledgerForTab(tabId).record({
          storeId: message.storeId,
          rootHash: message.rootHash,
          resourcePath: message.resourcePath,
          inclusionProofPassed: message.inclusionProofPassed === true,
          errorCode: message.errorCode,
          executionProofStatus: message.executionProofStatus,
        });
      }
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e && e.message });
    }
    return false;
  }

  // DIG Shields surface (popup Shield action): the active tab's capsule (storeId:rootHash),
  // its aggregate verification verdict, and the grouped per-resource proof ledger
  // (verified/failed). Mirrors the native browser's dig://shields per-capsule proof list.
  if (message.action === ACTIONS.getShieldLedger) {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0] && tabs[0].id;
        const verification = (typeof tabId === 'number' && tabVerification.get(tabId)) || null;
        const ledger = (typeof tabId === 'number' && tabLedger.get(tabId)) || null;
        // Derive the active capsule from the recorded entries (the loader keyed them by
        // storeId:rootHash); fall back to parsing the verified URN if no entries yet.
        let capsule = null;
        let entries = [];
        if (ledger) {
          // Most-recent capsule = the one with the most-recently recorded entry.
          for (const [, perResource] of ledger._byCapsule) {
            for (const e of perResource.values()) {
              if (e.storeId) { capsule = { storeId: e.storeId, rootHash: e.rootHash || 'latest' }; }
            }
          }
          if (capsule) entries = ledger.entriesFor(capsule.storeId, capsule.rootHash);
        }
        if (!capsule && verification && verification.urn) {
          const p = parseURN(String(verification.urn).replace(/^chia:\/\//, ''));
          if (p) capsule = { storeId: p.storeId, rootHash: p.roothash || 'latest' };
        }
        const group = groupLedger(entries);
        sendResponse({ capsule, verification, group, entries });
      } catch (e) {
        sendResponse({ capsule: null, verification: null, group: groupLedger([]), entries: [] });
      }
    })();
    return true;
  }

  // Server-side verification ledger (#307): fetch the local dig-node's AUTHORITATIVE
  // GET /verify/<storeId>[:<root>] for the active tab's capsule. The node retains each
  // /s/-served resource's verify verdict + Merkle inclusion-proof data (leaf/siblings/index/root)
  // in a bounded short-TTL ledger keyed by storeId:root; the popup renders the aggregate
  // "Verified by Chia" badge + the proof-inspection modal from it. Loopback-only + CORS'd for the
  // extension. Reads keep working over hosted RPC without a node, but the verification LEDGER is a
  // local-node-only surface — a missing node is reported honestly (the modal explains it).
  if (message.action === ACTIONS.getVerifyLedger) {
    (async () => {
      try {
        const base = await resolveLocalDigNode();
        if (!base) {
          sendResponse({
            success: false,
            code: 'NO_LOCAL_NODE',
            message: 'No local dig-node is reachable; verification inspection requires a running node.',
          });
          return;
        }
        // Derive the active tab's capsule (storeId + optional 64-hex root) exactly as the Shield
        // ledger does: prefer the recorded ledger entries, fall back to the verified URN.
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0] && tabs[0].id;
        const verification = (typeof tabId === 'number' && tabVerification.get(tabId)) || null;
        const ledger = (typeof tabId === 'number' && tabLedger.get(tabId)) || null;
        let storeId = null;
        let root = null;
        if (ledger) {
          for (const [, perResource] of ledger._byCapsule) {
            for (const e of perResource.values()) {
              if (e.storeId) {
                storeId = e.storeId;
                root = e.rootHash || null;
              }
            }
          }
        }
        if (!storeId && verification && verification.urn) {
          const p = parseURN(String(verification.urn).replace(/^chia:\/\//, ''));
          if (p) {
            storeId = p.storeId;
            root = p.roothash || null;
          }
        }
        if (!storeId) {
          sendResponse({
            success: false,
            code: 'NO_ACTIVE_CAPSULE',
            message: 'No DIG capsule is active on this tab.',
          });
          return;
        }
        // With a resolved 64-hex root, request the exact session; otherwise omit it (the node returns
        // the store's most-recently-updated session — a page has one active root).
        const b = base.endsWith('/') ? base.slice(0, -1) : base;
        const hasRoot = typeof root === 'string' && /^[0-9a-f]{64}$/i.test(root);
        const path = '/verify/' + storeId + (hasRoot ? ':' + root.toLowerCase() : '');
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 4000);
        let resp;
        try {
          resp = await fetch(b + path, { method: 'GET', signal: ac.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          sendResponse({
            success: false,
            code: 'VERIFY_HTTP_' + resp.status,
            message: 'The dig-node returned HTTP ' + resp.status + ' for the verification ledger.',
          });
          return;
        }
        const data = await resp.json();
        sendResponse(data);
      } catch (e) {
        sendResponse({
          success: false,
          code: 'VERIFY_FETCH_FAILED',
          message: (e && e.message) || 'Failed to read the verification ledger.',
        });
      }
    })();
    return true;
  }

  // Creator tips (#379, child of #377): one-tap manual $DIG tip for the active DIG resource's
  // creator. EXECUTION is the dig-node tipping subsystem's job (#377/#369 WS): the node resolves the
  // store's creator, builds + broadcasts the $DIG spend, and (with auto-tip) runs it unattended under
  // the configured caps. That subsystem is NOT built yet, so this is a FLAGGED STUB — it returns the
  // catalogued code TIP_SUBSYSTEM_UNAVAILABLE so the widget can honestly say tipping is coming soon.
  // When #377 lands, replace the stub body with the node tipping RPC/WS call
  // (`controlRpc`/`rpcCall(endpoint, 'dig.tipCreator', { store_id, amount_dig })`) and return its txId.
  if (message.action === ACTIONS.tipCreator) {
    sendResponse({
      success: false,
      code: 'TIP_SUBSYSTEM_UNAVAILABLE',
      message: 'The DIG node tipping service is not available yet.',
    });
    return true;
  }

  // DIG Control Panel (popup Control Panel action): detect a local dig-node and decide
  // manage-vs-install (mirrors the browser's dig://control), then best-effort read
  // control.status from the node. The mutating control.* surface is gated by a local control
  // token the extension cannot read (no filesystem access), so a node that answers
  // UNAUTHORIZED is reported as present-but-token-gated (authRequired) — the UI then deep-links
  // full management to the native DIG Browser. The hosted RPC fallback is always reported so
  // the UI can state honestly that reads keep working without a node.
  if (message.action === ACTIONS.getControlStatus) {
    (async () => {
      try {
        const hostedFallback = await getHostedRpcEndpoint();
        const view = await decideControlView({ resolveNode: resolveLocalDigNode, hostedFallback });
        let status = null;
        let authRequired = false;
        if (view.mode === 'manage' && view.controlEndpoint) {
          // Try control.status. An open node answers it; a token-gated node answers
          // UNAUTHORIZED (-32030, CONTROL_ERR.UNAUTHORIZED) — the expected outcome for the
          // token-less extension. (-32020 is retired/reserved for onion — see #130.)
          const resp = await controlRpc(view.controlEndpoint, 'control.status', {}).catch(() => null);
          if (resp && resp.result) {
            status = resp.result;
          } else if (isUnauthorizedControlResult(resp)) {
            authRequired = true; // node is present, but control.* needs the local token
          }
        }
        sendResponse({
          mode: view.mode,
          localNode: view.localNode,
          base: view.base,
          controlEndpoint: view.controlEndpoint,
          readFallback: view.readFallback,
          status,
          authRequired,
          controlMethods: [...CONTROL_METHODS],
        });
      } catch (e) {
        // Honest failure: treat as no node (install mode), reads still fall back to hosted.
        sendResponse({
          mode: 'install', localNode: false, base: null, controlEndpoint: null,
          readFallback: DEFAULT_RPC_ENDPOINT, status: null, authRequired: false,
          controlMethods: [...CONTROL_METHODS],
        });
      }
    })();
    return true;
  }

  // ─── dig-node control panel (#278/#281) ──────────────────────────────────────────────────────

  // #239: the SW-cached live node status (from the WS controller). The popup hydrates from this
  // and then live-patches from the `nodeLiveStatusChanged` broadcast — no polling.
  if (message.action === ACTIONS.getNodeLiveStatus) {
    sendResponse(_liveNodeStatus);
    return false;
  }

  // OPEN cache.* (#279 — no control token): drive the reserved-cap / LRU management surface.
  if (
    message.action === ACTIONS.cacheGetConfig ||
    message.action === ACTIONS.cacheSetCap ||
    message.action === ACTIONS.cacheList ||
    message.action === ACTIONS.cacheRemove ||
    message.action === ACTIONS.cacheClear ||
    message.action === ACTIONS.cacheStats
  ) {
    (async () => {
      const ep = await controlEndpointOrNull();
      if (!ep) { sendResponse({ success: false, error: 'no local dig-node' }); return; }
      const map = {
        [ACTIONS.cacheGetConfig]: ['cache.getConfig', {}],
        [ACTIONS.cacheSetCap]: ['cache.setCapBytes', { cap_bytes: message.capBytes }],
        [ACTIONS.cacheList]: ['cache.listCached', {}],
        [ACTIONS.cacheRemove]: ['cache.removeCached', { store_id: message.storeId, root: message.root }],
        [ACTIONS.cacheClear]: ['cache.clear', {}],
        [ACTIONS.cacheStats]: ['cache.stats', {}],
      };
      const [method, params] = map[message.action];
      const resp = await controlRpc(ep, method, params); // OPEN — no token
      if (resp && resp.result !== undefined) sendResponse(resp.result);
      else sendResponse({ success: false, error: (resp && resp.error && resp.error.message) || 'cache RPC failed' });
    })();
    return true;
  }

  // #280 pairing lifecycle: start / current-state / cancel / unpair. The pairing controller owns
  // the state machine + the poll loop + the stored token; these just drive it + return the state.
  if (message.action === ACTIONS.pairingStart) {
    (async () => { await pairingController.startPairing(); sendResponse(pairingController.getState()); })();
    return true;
  }
  if (message.action === ACTIONS.pairingState) {
    sendResponse(pairingController.getState());
    return false;
  }
  if (message.action === ACTIONS.pairingCancel) {
    pairingController.cancel();
    sendResponse(pairingController.getState());
    return false;
  }
  if (message.action === ACTIONS.pairingUnpair) {
    (async () => { await pairingController.unpair(); sendResponse(pairingController.getState()); })();
    return true;
  }

  // #281 authed control.*: drive a token-gated control method with the stored paired token. On a
  // -32030 the token is stale (operator revoked it) → clear it + drop back to unpaired.
  if (message.action === ACTIONS.controlAuthed) {
    (async () => {
      const ep = await controlEndpointOrNull();
      if (!ep) { sendResponse({ success: false, error: 'no local dig-node' }); return; }
      const token = pairingController.getToken();
      if (!token) { sendResponse({ success: false, error: 'not paired', code: -32030 }); return; }
      const resp = await controlRpc(ep, message.method, message.params || {}, token);
      if (isUnauthorizedControlResult(resp)) {
        // The stored token no longer authorizes (revoked): forget it so the UI re-pairs.
        await pairingController.unpair();
        sendResponse({ success: false, error: 'unauthorized', code: -32030 });
        return;
      }
      if (resp && resp.result !== undefined) { sendResponse(resp.result); return; }
      sendResponse({
        success: false,
        error: (resp && resp.error && resp.error.message) || 'control RPC failed',
        code: resp && resp.error && resp.error.code,
      });
    })();
    return true;
  }

  // Self-description: machine-readable capability/version surface. Returns the message
  // protocol version, the full ACTIONS list, the wallet method surface, and the error-code
  // catalogue so an agent can introspect the whole extension contract with one call.
  if (message.action === ACTIONS.getCapabilities) {
    let version = 'unknown';
    try { version = chrome.runtime.getManifest().version || 'unknown'; } catch { /* ignore */ }
    sendResponse(buildCapabilities(version));
    return false;
  }

  // #292 — the injected page toolbar asks the SW to open a full-page extension surface in a NEW tab
  // (a content script has no `tabs` permission). Only `app.html` deep-links are honoured (the page
  // is resolved through chrome.runtime.getURL, so an arbitrary external URL can never be opened).
  if (message.action === ACTIONS.openExtensionPage) {
    (async () => {
      try {
        const page = String(message.page || 'app.html');
        if (!page.startsWith('app.html')) throw new Error('unsupported page');
        await chrome.tabs.create({ url: chrome.runtime.getURL(page) });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  // #366 — resolve the ACTUAL bound keyboard shortcut for the show/hide command. A content script
  // (the injected toolbar) can't call chrome.commands itself, so it asks the SW. `shortcut` is the
  // empty string when the command exists but the user cleared its binding — the caller then falls
  // back to the manifest default via `toolbarShortcutHint`.
  if (message.action === ACTIONS.getToolbarShortcut) {
    (async () => {
      let shortcut = '';
      try {
        const cmds = await chrome.commands.getAll();
        const cmd = Array.isArray(cmds) ? cmds.find((c) => c && c.name === TOOLBAR_TOGGLE_COMMAND) : null;
        shortcut = (cmd && cmd.shortcut) || '';
      } catch {
        /* chrome.commands unavailable — the caller falls back to the manifest default */
      }
      try { sendResponse({ shortcut }); } catch { /* port closed */ }
    })();
    return true;
  }

  // Popup approves/revokes a per-origin wallet connection request.
  if (message.action === 'walletConsent') {
    (async () => {
      try {
        await setOriginApproval(chrome.storage.local, message.origin, !!message.approved);
        // Drop it from the pending list.
        const { 'wallet.pendingOrigins': pend } = await chrome.storage.local.get('wallet.pendingOrigins');
        const list = (Array.isArray(pend) ? pend : []).filter((o) => o !== message.origin);
        await chrome.storage.local.set({ 'wallet.pendingOrigins': list });
        // Clear the toolbar attention badge once nothing is pending.
        await clearWalletAttentionIfEmpty();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  return false;
});

// Helper to check if URL is localhost
function isLocalhostUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1';
  } catch (e) {
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  }
}

// Helper to check if URL is dig.local (including subdomains)
function isDigLocalUrl(url) {
  if (!url) return false;
  try {
    // Normalize URL - add protocol if missing
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://') && !normalizedUrl.startsWith('chrome-extension://')) {
      normalizedUrl = 'http://' + normalizedUrl;
    }
    const urlObj = new URL(normalizedUrl);
    // Check if hostname is dig.local or *.dig.local
    return urlObj.hostname === 'dig.local' || urlObj.hostname.endsWith('.dig.local');
  } catch (e) {
    // Fallback: check if it contains dig.local
    return url.includes('dig.local') && !url.includes('chrome-extension://');
  }
}

// Resolve dig.local subdomain URL back to URN
// Removed: No subdomain redirection - chia:// URLs go directly to RPC
// function resolveSubdomainToURN(url) { ... }

// Handle chia:// URL navigation by fetching content and streaming as data URL
// while keeping chia:// in the address bar
// Simple function to redirect to dig-viewer.html with URN
async function redirectToViewer(tabId, digUrl) {
  console.log('DIG Extension: redirectToViewer called with:', digUrl);
  
  // Extract URN from chia:// URL (remove chia:// prefix)
  const urn = digUrl.replace(/^chia:\/\//, '');
  
  // Construct viewer URL with URN parameter
  const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
  
  console.log('DIG Extension: Redirecting to viewer:', viewerUrl);
  
  // Redirect to viewer page
  await chrome.tabs.update(tabId, {
    url: viewerUrl
  });
  
  console.log('DIG Extension: Successfully redirected to viewer');
}

async function handleDigUrlNavigation(tabId, digUrl) {
  console.log('DIG Extension: handleDigUrlNavigation called with:', digUrl);
  
  // Check if we've already processed this URL recently (prevent loops)
  const urlKey = `${tabId}:${digUrl}`;
  const lastProcessed = processedUrls.get(urlKey);
  if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
    console.log('DIG Extension: URL already processed recently, skipping to prevent loop:', digUrl);
    return;
  }
  
  // Mark this URL as processed
  processedUrls.set(urlKey, Date.now());

  // Clean up old entries periodically
  if (processedUrls.size > 100) {
    const now = Date.now();
    for (const [key, timestamp] of processedUrls.entries()) {
      if (now - timestamp > PROCESSED_URL_TTL) {
        processedUrls.delete(key);
      }
    }
  }

  // #311 — instant, never-blank paint: flash the tab to the branded DIG loader page FIRST (an
  // extension page that paints immediately, mirroring on.dig.net's loader-shell UX) BEFORE the §5.3
  // node probe + resolve below, which can take up to ~1.2s. The loader does no resolving itself —
  // it is a purely visual interstitial; the resolve below swaps the tab to the real destination (or
  // the branded recoverable error page, on failure) once ready. Best-effort: a failure to paint the
  // loader must never block the real resolve/navigate that follows.
  try {
    const loaderUrl = chrome.runtime.getURL(`dig-loader.html?input=${encodeURIComponent(digUrl)}`);
    await chrome.tabs.update(tabId, { url: loaderUrl });
  } catch (e) {
    console.warn('DIG Extension: could not paint the DIG loader page first', e);
  }

  try {
    // #289 — §5.3 node-or-sandbox decision. Resolve the LOCAL dig-node (dig.local preferred, then
    // 127.0.0.1:<port>; an explicitly-configured custom host wins the ladder entirely). A short
    // probe timeout keeps navigation snappy; any failure ⇒ treat as "no local node".
    const { 'server.host': host } = await chrome.storage.local.get('server.host');
    const nodeBase = await resolveDigNode(host, { timeoutMs: 1200 }).catch(() => null);
    const target = chooseNavTarget({ digUrl, nodeBase });

    if (target.kind === 'node') {
      // A local node is up: navigate the TAB DIRECTLY to the node's plaintext content-serve surface
      // (an ordinary website — the trusted, loopback, key-holding node decrypts server-side and sets
      // the DIG Shields X-Dig-* headers). This REPLACES the sandbox viewer for the local-node case.
      console.log('DIG Extension: navigating tab to node-served plaintext surface:', target.url);
      await chrome.tabs.update(tabId, { url: target.url });
      return;
    }

    // No local node: keep the sandbox dig-viewer + rpc.dig.net ciphertext + in-browser-decrypt path
    // (a browser cannot obtain plaintext from the public gateway — privacy preserved).
    const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(target.urn)}`);
    console.log('DIG Extension: no local node — redirecting to sandbox viewer:', viewerUrl);
    await chrome.tabs.update(tabId, { url: viewerUrl });
    console.log('DIG Extension: Successfully redirected to viewer');
  } catch (error) {
    console.error('DIG Extension: Error in handleDigUrlNavigation:', error);
    await chrome.tabs.update(tabId, { url: digErrorPageUrl(digUrl, error) });
  }
}

// #362 — the ONE shared entry-navigation core. Every entry surface (the `dig` omnibox, the raw
// `urn:`/`chia://` URL-bar interception #310, the toolbar URN bars' on-dig-net form #306, and the
// custom DIG search resolver page #362) hands its RAW input here, so the classify → resolve → load
// decision lives in exactly one place. `classifyDigInput` (dig-nav) does the pure classification:
//   - `urn`        → a canonical chia:// → the §5.4 node-or-sandbox nav (handleDigUrlNavigation);
//   - `on-dig-net` → HEAD→URN (#308, from the EXTENSION origin so the X-Dig-URN CORS header is
//                    readable), then the §5.4 nav; a failed resolve opens the on.dig.net subdomain;
//   - `url`        → navigate the tab straight to it;
//   - `web`        → the user's configurable fallback web-search engine (search-fallback).
async function handleResolvedNavigation(tabId, rawInput) {
  const c = classifyDigInput(rawInput);
  if (c.kind === 'urn') {
    await handleDigUrlNavigation(tabId, c.chiaUrl);
    return;
  }
  if (c.kind === 'on-dig-net') {
    const chiaUrl = await resolveOnDigNetUrn(c.host).catch(() => null);
    if (chiaUrl) {
      await handleDigUrlNavigation(tabId, chiaUrl);
    } else {
      // Unmapped / no header — fall back to opening the on.dig.net subdomain directly.
      await chrome.tabs.update(tabId, { url: `https://${c.host}/` });
    }
    return;
  }
  if (c.kind === 'url') {
    await chrome.tabs.update(tabId, { url: c.url });
    return;
  }
  const dest = buildFallbackSearchUrl(await getFallbackTemplate(), c.query);
  await chrome.tabs.update(tabId, { url: dest });
}

// Helper function to convert chia:// URL and redirect to viewer
// This is now just a wrapper around handleDigUrlNavigation
async function redirectDigUrlToLocalhost(tabId, digUrl) {
  if (!digUrl || !digUrl.startsWith('chia://')) {
    return false;
  }
  
  console.log('DIG Extension: redirectDigUrlToLocalhost called with:', digUrl);
  
  const result = await chrome.storage.local.get(['extensionEnabled']);
  const isEnabled = result.extensionEnabled !== false; // Default to true
  
  if (!isEnabled) {
    console.log('DIG Extension: Extension is disabled');
    return false;
  }
  
  // Use handleDigUrlNavigation which redirects to dig-viewer.html
  try {
    await handleDigUrlNavigation(tabId, digUrl);
    console.log('DIG Extension: Successfully redirected to viewer');
    return true;
  } catch (error) {
    console.error('DIG Extension: Failed to redirect to viewer:', error);
    return false;
  }
}

// Helper function to redirect dig.local to content server
// Disabled: No subdomain redirection - chia:// URLs go directly to RPC
async function redirectDigLocalToExtension(tabId, digLocalUrl) {
  // No-op: All chia:// URLs should go directly to RPC, no subdomain conversion
  return false;
}

// Handle navigation to chia:// URLs via webNavigation (for in-page navigation and address bar)
// This is the PRIMARY interceptor - catches chia:// URLs before Chrome processes them
// NOTE: For address bar navigation, Chrome may show an external protocol dialog briefly
// before the extension can intercept. This is a Chrome limitation.
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (details.url && details.url.includes('dig-viewer.html')) {
      return;
    }
    
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }

    // #362 Tier 4 — a DIG-search sentinel navigation (the search provider's search_url). Land it on
    // the in-extension resolver page locally (the declarativeNetRequest rule below is the pre-network
    // path; this is the guaranteed fallback), so a DIG-search query never round-trips to dig.net.
    if (details.url && details.frameId === 0) {
      const q = matchDigSearchSentinel(details.url);
      if (q != null) {
        await chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL(`${DIG_SEARCH_RESOLVER_PAGE}?q=${encodeURIComponent(q)}`),
        });
        return;
      }
    }

    // #310 — a bare `urn:` scheme (a typed/clicked `urn:dig:chia:…`). Route through the SAME shared
    // classify → resolve → node-load core as `chia://` and the `dig` omnibox.
    if (details.url && /^urn:/i.test(details.url) && details.frameId === 0) {
      const enabled = (await chrome.storage.local.get(['extensionEnabled'])).extensionEnabled !== false;
      if (enabled) {
        try {
          await handleResolvedNavigation(details.tabId, details.url);
        } catch (error) {
          console.error('DIG Extension: Error handling urn: navigation:', error);
        }
      }
      return;
    }

    // Handle chia:// URLs - fetch content and stream as data URL while keeping chia:// in URL bar
    if (details.url && details.url.startsWith('chia://')) {
      console.log('DIG Extension: onBeforeNavigate caught chia:// URL:', details.url);
      const enabledResult = await chrome.storage.local.get(['extensionEnabled']);
      const isEnabled = enabledResult.extensionEnabled !== false;
      
      if (isEnabled) {
        // Interrupt navigation and fetch content to stream as data URL
        try {
          // Cancel the current navigation by redirecting immediately
          // Use handleDigUrlNavigation which loads as data URL and keeps chia:// in URL bar
          await handleDigUrlNavigation(details.tabId, details.url);
        } catch (error) {
          console.error('DIG Extension: Error handling chia:// navigation:', error);
          await chrome.tabs.update(details.tabId, { url: digErrorPageUrl(details.url, error) });
        }
      } else {
        console.log('DIG Extension: Extension is disabled, not redirecting');
      }
      return;
    }
    
    // Also check for Google search pages with chia:// in query (catch before page loads)
    // IMPORTANT: Skip if we're already navigating to a data URL, dig.local, or viewer to prevent loops
    if (details.url && details.frameId === 0 && 
        !details.url.startsWith('data:') && 
        !isDigLocalUrl(details.url) &&
        !details.url.includes('dig-viewer.html')) {
      const searchEngines = ['google.com/search', 'www.google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
      const isSearchPage = searchEngines.some(engine => details.url.includes(engine));
      
      if (isSearchPage) {
        try {
          const urlObj = new URL(details.url);
          const queryParams = ['q', 'query', 'text', 'p', 'wd'];
          let query = null;
          
          for (const param of queryParams) {
            query = urlObj.searchParams.get(param);
            if (query) break;
          }
          
          if (query) {
            let digUrl = null;
            
            // Try multiple decoding passes (Google may double-encode)
            let decodedQuery = query;
            for (let i = 0; i < 3; i++) {
              // First try direct match
              const digMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
              if (digMatch) {
                digUrl = digMatch[0];
                break;
              }
              
              // Try URL-decoding
              try {
                const nextDecoded = decodeURIComponent(decodedQuery);
                if (nextDecoded === decodedQuery) {
                  // No more decoding possible
                  break;
                }
                decodedQuery = nextDecoded;
              } catch (e) {
                // Already decoded or invalid encoding
                break;
              }
            }
            
            // Final check on fully decoded query
            if (!digUrl) {
              const finalMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
              if (finalMatch) {
                digUrl = finalMatch[0];
              }
            }
            
            if (digUrl) {
              // Check if we've already processed this to prevent loops
              const urlKey = `${details.tabId}:${digUrl}`;
              const lastProcessed = processedUrls.get(urlKey);
              if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                console.log('DIG Extension: Already processing this chia:// URL, skipping to prevent loop');
                return;
              }
              
              console.log('DIG Extension: onBeforeNavigate detected chia:// in search, immediately replacing:', digUrl);
              const searchEnabledResult = await chrome.storage.local.get(['extensionEnabled']);
              const isEnabled = searchEnabledResult.extensionEnabled !== false;
              
              if (isEnabled) {
                try {
                  await handleDigUrlNavigation(details.tabId, digUrl);
                  return; // Exit early
                } catch (error) {
                  console.error('DIG Extension: Error in onBeforeNavigate handleDigUrlNavigation:', error);
                  await redirectDigUrlToLocalhost(details.tabId, digUrl);
                  return;
                }
              }
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }
    }
    
    // Handle dig.local URLs - redirect to extension test site BEFORE DNS resolution
    if (details.url && isDigLocalUrl(details.url)) {
      const digLocalEnabledResult = await chrome.storage.local.get(['extensionEnabled']);
      const isEnabled = digLocalEnabledResult.extensionEnabled !== false;
      
      if (isEnabled) {
        // Redirect immediately before DNS resolution fails
        await redirectDigLocalToExtension(details.tabId, details.url);
      }
      return;
    }
  },
  { url: [{ schemes: ['chia', 'urn', 'http', 'https'] }] }
);

// Also handle chia:// links clicked in pages (using content script approach)
chrome.webNavigation.onCommitted.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (details.url && details.url.includes('dig-viewer.html')) {
      return;
    }
    
    // Skip localhost URLs - these are already redirected
    if (isLocalhostUrl(details.url)) {
      return;
    }
    
    if (details.url && details.url.startsWith('chia://') && details.frameId === 0) {
      // Only main frame - use handleDigUrlNavigation to load as data URL
      try {
        await handleDigUrlNavigation(details.tabId, details.url);
      } catch (error) {
        console.error('DIG Extension: Error in onCommitted handleDigUrlNavigation:', error);
        await redirectDigUrlToLocalhost(details.tabId, details.url);
      }
      return;
    }
    
    // Handle dig.local URLs - redirect to content server (fallback for onCommitted)
    if (details.url && isDigLocalUrl(details.url) && details.frameId === 0) {
      await redirectDigLocalToExtension(details.tabId, details.url);
    }
    
    // Aggressively catch Google search pages with chia:// in query and redirect immediately
    // This replaces the Google search page with the dig-viewer.html
    // IMPORTANT: Skip if we're already on a data URL, dig.local, or viewer to prevent loops
    if (details.url && details.frameId === 0 && 
        !details.url.startsWith('data:') && 
        !isDigLocalUrl(details.url) &&
        !details.url.includes('dig-viewer.html')) {
      const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
      const isSearchPage = searchEngines.some(engine => details.url.includes(engine));
      
      if (isSearchPage) {
        try {
          const urlObj = new URL(details.url);
          const queryParams = ['q', 'query', 'text', 'p', 'wd'];
          let query = null;
          
          for (const param of queryParams) {
            query = urlObj.searchParams.get(param);
            if (query) break;
          }
          
          if (query) {
            // URLSearchParams.get() automatically decodes, but handle both encoded and decoded cases
            // Try to find chia:// URL in the query (might be URL-encoded or plain)
            let digUrl = null;
            
            // Try multiple decoding passes (Google may double-encode)
            let decodedQuery = query;
            for (let i = 0; i < 3; i++) {
              // First try direct match
              const digMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
              if (digMatch) {
                digUrl = digMatch[0];
                break;
              }
              
              // Try URL-decoding
              try {
                const nextDecoded = decodeURIComponent(decodedQuery);
                if (nextDecoded === decodedQuery) {
                  // No more decoding possible
                  break;
                }
                decodedQuery = nextDecoded;
              } catch (e) {
                // Already decoded or invalid encoding
                break;
              }
            }
            
            // Final check on fully decoded query
            if (!digUrl) {
              const finalMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
              if (finalMatch) {
                digUrl = finalMatch[0];
              }
            }
            
            if (digUrl) {
              // Check if we've already processed this to prevent loops
              const urlKey = `${details.tabId}:${digUrl}`;
              const lastProcessed = processedUrls.get(urlKey);
              if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                console.log('DIG Extension: Already processing this chia:// URL in onCommitted, skipping to prevent loop');
                return;
              }
              
              console.log('DIG Extension: onCommitted detected chia:// in search query, redirecting to viewer:', digUrl);
              // Use handleDigUrlNavigation to redirect to dig-viewer.html
              try {
                await handleDigUrlNavigation(details.tabId, digUrl);
                console.log('DIG Extension: Successfully redirected from Google search to viewer');
                return; // Exit early to prevent further processing
              } catch (error) {
                console.error('DIG Extension: Error in onCommitted handleDigUrlNavigation:', error);
                return;
              }
            }
          }
        } catch (e) {
          console.warn('DIG Extension: Error parsing search URL:', e);
        }
      }
    }
  },
  { url: [{ schemes: ['chia', 'http', 'https'] }] }
);

// Handle tabs opened with chia:// URLs (from protocol handler, command line, or address bar)
// This catches when Chrome is launched with chia:// URL from OS protocol handler
// Also catches address bar navigation that might have been missed by onBeforeNavigate
chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    // Skip data URLs - these are final destinations, don't intercept
    if (tab.url && tab.url.startsWith('data:')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.startsWith('data:')) {
      return;
    }
    
    // Skip chrome-extension:// URLs for the viewer page - these are internal
    if (tab.url && tab.url.includes('dig-viewer.html')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.includes('dig-viewer.html')) {
      return;
    }
    
    // Process when URL changes or when tab is loading
    if (changeInfo.url) {
      // URL changed - check if it's chia:// (catches address bar navigation)
      if (tab.url && tab.url.startsWith('chia://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
        return;
      }
    }
    
    // Also check when status changes to loading (catches initial load)
    // This is important for address bar navigation
    if (changeInfo.status === 'loading') {
      if (tab.url && tab.url.startsWith('chia://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
        return;
      }
      
      // Also check if it's a search page with chia:// in URL (very early catch)
      if (tab.url && !tab.url.includes('dig-viewer.html')) {
        const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
            const queryParams = ['q', 'query', 'text', 'p', 'wd'];
            let query = null;
            
            for (const param of queryParams) {
              query = urlObj.searchParams.get(param);
              if (query) break;
            }
            
            if (query) {
              let digUrl = null;
              
              // Try multiple decoding passes (Google may double-encode)
              let decodedQuery = query;
              for (let i = 0; i < 3; i++) {
                // First try direct match
                const digMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
                if (digMatch) {
                  digUrl = digMatch[0];
                  break;
                }
                
                // Try URL-decoding
                try {
                  const nextDecoded = decodeURIComponent(decodedQuery);
                  if (nextDecoded === decodedQuery) {
                    // No more decoding possible
                    break;
                  }
                  decodedQuery = nextDecoded;
                } catch (e) {
                  // Already decoded or invalid encoding
                  break;
                }
              }
              
              // Final check on fully decoded query
              if (!digUrl) {
                const finalMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
                if (finalMatch) {
                  digUrl = finalMatch[0];
                }
              }
              
              if (digUrl) {
                console.log('DIG Extension: Early detection of chia:// in search (tabs.onUpdated), redirecting to viewer:', digUrl);
                try {
                  await handleDigUrlNavigation(tabId, digUrl);
                  return;
                } catch (error) {
                  console.error('DIG Extension: Error redirecting from search:', error);
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
    }
    
    // Check when tab becomes complete (fallback for any missed cases)
    if (changeInfo.status === 'complete') {
      if (tab.url && tab.url.startsWith('chia://') && !isLocalhostUrl(tab.url)) {
        await handleDigUrlNavigation(tabId, tab.url);
        return;
      }
      
      // Also check for Google search pages when tab completes (final fallback)
      if (tab.url && !tab.url.includes('dig-viewer.html') && !tab.url.startsWith('data:')) {
        const searchEngines = ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'yahoo.com/search', 'search.yahoo.com'];
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
            const queryParams = ['q', 'query', 'text', 'p', 'wd'];
            let query = null;
            
            for (const param of queryParams) {
              query = urlObj.searchParams.get(param);
              if (query) break;
            }
            
            if (query) {
              let digUrl = null;
              
              // Try multiple decoding passes (Google may double-encode)
              let decodedQuery = query;
              for (let i = 0; i < 3; i++) {
                // First try direct match
                const digMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
                if (digMatch) {
                  digUrl = digMatch[0];
                  break;
                }
                
                // Try URL-decoding
                try {
                  const nextDecoded = decodeURIComponent(decodedQuery);
                  if (nextDecoded === decodedQuery) {
                    // No more decoding possible
                    break;
                  }
                  decodedQuery = nextDecoded;
                } catch (e) {
                  // Already decoded or invalid encoding
                  break;
                }
              }
              
              // Final check on fully decoded query
              if (!digUrl) {
                const finalMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
                if (finalMatch) {
                  digUrl = finalMatch[0];
                }
              }
              
              if (digUrl) {
                console.log('DIG Extension: Final fallback - detected chia:// in completed search page, redirecting to viewer:', digUrl);
                try {
                  await handleDigUrlNavigation(tabId, digUrl);
                  return;
                } catch (error) {
                  console.error('DIG Extension: Error in final fallback redirect:', error);
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
      
      // Check if it's dig.local
      if (tab.url && isDigLocalUrl(tab.url)) {
        await redirectDigLocalToExtension(tabId, tab.url);
      }
    }
    
    // Also check pendingUrl for address bar navigation (very early catch)
    if (tab.pendingUrl) {
      if (tab.pendingUrl.startsWith('chia://') && !isLocalhostUrl(tab.pendingUrl)) {
        // Use handleDigUrlNavigation to load as data URL
        try {
          await handleDigUrlNavigation(tabId, tab.pendingUrl);
        } catch (error) {
          console.error('DIG Extension: Error in pendingUrl handleDigUrlNavigation:', error);
          await redirectDigUrlToLocalhost(tabId, tab.pendingUrl);
        }
        return;
      }
      
      // Check if it's dig.local
      if (isDigLocalUrl(tab.pendingUrl)) {
        await redirectDigLocalToExtension(tabId, tab.pendingUrl);
      }
    }
  }
);

// Also listen for tab creation (when new tab/window is opened with chia:// URL)
chrome.tabs.onCreated.addListener(
  async (tab) => {
    // Skip data URLs - these are final destinations
    if (tab.url && tab.url.startsWith('data:')) {
      return;
    }
    if (tab.pendingUrl && tab.pendingUrl.startsWith('data:')) {
      return;
    }
    
    // Check if tab has a chia:// URL (might be pending or already set)
    if (tab.url && tab.url.startsWith('chia://')) {
      // URL is already set, redirect immediately
      setTimeout(async () => {
        await redirectDigUrlToLocalhost(tab.id, tab.url);
      }, 50);
    } else if (tab.pendingUrl && tab.pendingUrl.startsWith('chia://')) {
      // URL is pending, wait a bit then check again
      setTimeout(async () => {
        try {
          const updatedTab = await chrome.tabs.get(tab.id);
          // Skip if it's now a data URL
          if (updatedTab.url && updatedTab.url.startsWith('data:')) {
            return;
          }
          if (updatedTab.url && updatedTab.url.startsWith('chia://')) {
            await redirectDigUrlToLocalhost(updatedTab.id, updatedTab.url);
          } else if (updatedTab.pendingUrl && updatedTab.pendingUrl.startsWith('chia://')) {
            await redirectDigUrlToLocalhost(updatedTab.id, updatedTab.pendingUrl);
          }
        } catch (error) {
          console.error('DIG Extension: Error handling new tab:', error);
        }
      }, 100);
    }
    
    // Check if tab has a dig.local URL
    if (tab.url && isDigLocalUrl(tab.url)) {
      setTimeout(async () => {
        await redirectDigLocalToExtension(tab.id, tab.url);
      }, 50);
    } else if (tab.pendingUrl && isDigLocalUrl(tab.pendingUrl)) {
      setTimeout(async () => {
        try {
          const updatedTab = await chrome.tabs.get(tab.id);
          if (updatedTab.url && isDigLocalUrl(updatedTab.url)) {
            await redirectDigLocalToExtension(updatedTab.id, updatedTab.url);
          } else if (updatedTab.pendingUrl && isDigLocalUrl(updatedTab.pendingUrl)) {
            await redirectDigLocalToExtension(updatedTab.id, updatedTab.pendingUrl);
          }
        } catch (error) {
          console.error('DIG Extension: Error handling new tab:', error);
        }
      }, 100);
    }
  }
);

// Catch DNS errors for dig.local and protocol errors for chia://
chrome.webNavigation.onErrorOccurred.addListener(
  async (details) => {
    // Skip data URLs - these are final destinations
    if (details.url && details.url.startsWith('data:')) {
      return;
    }
    
    // Check if this is a DNS error for dig.local
    if ((details.error === 'net::ERR_NAME_NOT_RESOLVED' || details.error === 'net::ERR_NAME_RESOLUTION_FAILED') && details.frameId === 0) {
      if (details.url && isDigLocalUrl(details.url)) {
        console.log('DIG Extension: Caught DNS error for dig.local, redirecting to content server');
        await redirectDigLocalToExtension(details.tabId, details.url);
      }
    }

    // dig-dns Path-B proxy fallback (#175): a real `.dig` navigation could not reach its host —
    // Path A (OS split-DNS) is not routing it right now. Engage the PAC proxy fallback if dig-dns
    // itself is reachable (self-heals back to direct once dig-dns has stayed healthy for a while).
    if (isDotDigNavigationFailure(details)) {
      digDnsController.reportNavigationError().catch(() => {});
    }
    
    // Check if this is a protocol error for chia:// (Chrome redirecting to search)
    // Errors like ERR_UNKNOWN_URL_SCHEME indicate Chrome doesn't recognize the protocol
    if ((details.error === 'net::ERR_UNKNOWN_URL_SCHEME' || 
         details.error === 'net::ERR_INVALID_URL' ||
         details.error === 'net::ERR_FAILED') && 
        details.frameId === 0) {
      if (details.url && details.url.startsWith('chia://')) {
        console.log('DIG Extension: Caught protocol error for chia://, redirecting:', details.url);
        try {
          await handleDigUrlNavigation(details.tabId, details.url);
        } catch (error) {
          console.error('DIG Extension: Error in onErrorOccurred handleDigUrlNavigation:', error);
          await redirectDigUrlToLocalhost(details.tabId, details.url);
        }
      }
    }
  }
);

// Low-frequency backstop sweep — catches the rare case where a chia:// navigation slips
// past onBeforeNavigate, or where a search engine rewrote a chia:// query. The primary
// path is event-driven (onBeforeNavigate + the omnibox/search handlers); this is the
// safety net, so it runs every few seconds rather than the old tight 100ms loop.
setInterval(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // Check pendingUrl for chia:// or dig.local (catches address bar input)
      if (tab.pendingUrl) {
        if (tab.pendingUrl.startsWith('chia://')) {
          // Use handleDigUrlNavigation to load as data URL
          try {
            await handleDigUrlNavigation(tab.id, tab.pendingUrl);
          } catch (error) {
            console.error('DIG Extension: Error in interval pendingUrl handleDigUrlNavigation:', error);
            await redirectDigUrlToLocalhost(tab.id, tab.pendingUrl);
          }
          continue;
        }
        if (isDigLocalUrl(tab.pendingUrl)) {
          await redirectDigLocalToExtension(tab.id, tab.pendingUrl);
          continue;
        }
      }
      
      // Check if current URL is a search engine page with chia:// in the query
      // Support Google, Bing, DuckDuckGo, Yahoo, and other search engines
      // IMPORTANT: Skip if we're already on a data URL or dig.local to prevent loops
      if (tab.url && !tab.url.startsWith('data:') && !isDigLocalUrl(tab.url)) {
        const searchEngines = [
          'google.com/search',
          'bing.com/search',
          'duckduckgo.com',
          'yahoo.com/search',
          'search.yahoo.com',
          'yandex.com/search',
          'baidu.com/s'
        ];
        
        const isSearchPage = searchEngines.some(engine => tab.url.includes(engine));
        
        if (isSearchPage) {
          try {
            const urlObj = new URL(tab.url);
            // Try different query parameter names used by different search engines
            const queryParams = ['q', 'query', 'text', 'p', 'wd'];
            let query = null;
            
            for (const param of queryParams) {
              query = urlObj.searchParams.get(param);
              if (query) break;
            }
            
            if (query) {
              // Extract chia:// URL from query (might be anywhere in the query string)
              // Handle both URL-encoded and plain text
              let digUrl = null;
              
              // First try direct match (already decoded by searchParams.get)
              const digMatch = query.match(/chia:\/\/[^\s"']+/);
              if (digMatch) {
                digUrl = digMatch[0];
              } else {
                // Try URL-decoding the entire query in case it's double-encoded
                try {
                  const decodedQuery = decodeURIComponent(query);
                  const decodedMatch = decodedQuery.match(/chia:\/\/[^\s"']+/);
                  if (decodedMatch) {
                    digUrl = decodedMatch[0];
                  }
                } catch (e) {
                  // Already decoded or invalid encoding
                }
              }
              
              // Also check if the entire query IS a chia:// URL (Chrome might have encoded it)
              if (!digUrl && query.includes('chia%3A%2F%2F')) {
                try {
                  const decoded = decodeURIComponent(query);
                  if (decoded.startsWith('chia://')) {
                    digUrl = decoded;
                  }
                } catch (e) {
                  // Ignore decode errors
                }
              }
              
              // Also check if query contains urn:dig: pattern (might be the URN without chia:// prefix)
              if (!digUrl) {
                const urnMatch = query.match(/urn:dig:[^\s"']+/);
                if (urnMatch) {
                  digUrl = 'chia://' + urnMatch[0];
                } else {
                  // Try URL-decoded version
                  try {
                    const decodedQuery = decodeURIComponent(query);
                    const decodedUrnMatch = decodedQuery.match(/urn:dig:[^\s"']+/);
                    if (decodedUrnMatch) {
                      digUrl = 'chia://' + decodedUrnMatch[0];
                    }
                  } catch (e) {
                    // Ignore
                  }
                }
              }
              
              if (digUrl) {
                // Check if we've already processed this to prevent loops
                const urlKey = `${tab.id}:${digUrl}`;
                const lastProcessed = processedUrls.get(urlKey);
                if (lastProcessed && (Date.now() - lastProcessed) < PROCESSED_URL_TTL) {
                  console.log('DIG Extension: Already processing this chia:// URL in interval check, skipping to prevent loop');
                  continue;
                }
                
                console.log('DIG Extension: Interval check detected chia:// URL in search query, redirecting to viewer:', digUrl);
                // Use handleDigUrlNavigation to route to dig-viewer.html → RPC
                try {
                  await handleDigUrlNavigation(tab.id, digUrl);
                  console.log('DIG Extension: Successfully replaced search page with chia:// content');
                } catch (error) {
                  console.error('DIG Extension: Error in interval handleDigUrlNavigation:', error);
                  await redirectDigUrlToLocalhost(tab.id, digUrl);
                }
                continue;
              }
            }
          } catch (e) {
            // Ignore URL parsing errors
          }
        }
      }
      
      // Check if URL contains dig.local (might be in error state)
      if (tab.url && tab.url.includes('dig.local') && !tab.url.startsWith('chrome-extension://')) {
        // Make sure it's a dig.local URL, not just containing the text
        try {
          const urlObj = new URL(tab.url);
          if (urlObj.hostname === 'dig.local') {
            await redirectDigLocalToExtension(tab.id, tab.url);
          }
        } catch (e) {
          // If URL parsing fails, try to construct a proper dig.local URL
          if (tab.url.includes('dig.local')) {
            const digLocalUrl = tab.url.startsWith('http') ? tab.url : `http://${tab.url}`;
            if (isDigLocalUrl(digLocalUrl)) {
              await redirectDigLocalToExtension(tab.id, digLocalUrl);
            }
          }
        }
      }
      
      // Also check if URL contains chia:// (might be in error or search state)
      if (tab.url && tab.url.includes('chia://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('chia://')) {
        // Try to extract chia:// URL from the current URL
        const digMatch = tab.url.match(/chia:\/\/[^\s"']+/);
        if (digMatch) {
          const digUrl = digMatch[0];
          console.log('DIG Extension: Detected chia:// URL in current page, redirecting:', digUrl);
          await redirectDigUrlToLocalhost(tab.id, digUrl);
        }
      }
    }
  } catch (error) {
    // Ignore errors
  }
}, 3000); // Low-frequency backstop (was 100ms); the primary path is event-driven.

// Omnibox `dig` keyword (#291) — type `dig <chia:// | urn:dig: | storeId[:root] | <label>.dig |
// <sub>.on.dig.net | url | words>`. Routes the typed input through the ONE shared classify → resolve
// → load core (`handleResolvedNavigation`, #362), the SAME path the raw `urn:`/`chia://` URL-bar
// interception (#310) and the DIG search resolver (#362) use: a DIG address → the §5.4
// node-or-sandbox nav; an `*.on.dig.net`/`.dig` shorthand → HEAD→URN (#308); a URL → navigate; free
// text → the configurable fallback web-search engine. `currentTab` reuses the active tab; any other
// disposition opens a new tab.
chrome.omnibox.onInputEntered.addListener(
  async (text, disposition) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    console.log('DIG Extension: Omnibox input:', trimmed, '(', disposition, ')');

    const openInCurrent = disposition === 'currentTab';
    let tabId = null;
    if (openInCurrent) {
      const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      tabId = active?.id ?? null;
    }
    if (tabId == null) tabId = (await chrome.tabs.create({ url: 'about:blank' })).id ?? null;
    if (tabId != null) await handleResolvedNavigation(tabId, trimmed);
  }
);

// #366 — the show/hide keyboard command. `chrome.commands.onCommand` fires when the user presses the
// bound shortcut (default Alt+Shift+D, rebindable at chrome://extensions/shortcuts). It FLIPS the
// existing `toolbar.enabled` storage key; both toolbar mounts (the injected content script + the
// built-in fullscreen React bar) already re-render live off `storage.onChanged`, so no new toggle
// path is needed — this reuses the exact wiring the header switch drives.
try {
  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
      if (command !== TOOLBAR_TOGGLE_COMMAND) return;
      try {
        const got = await chrome.storage.local.get(TOOLBAR_ENABLED_KEY);
        const current = typeof got[TOOLBAR_ENABLED_KEY] === 'boolean' ? got[TOOLBAR_ENABLED_KEY] : TOOLBAR_ENABLED_DEFAULT;
        await chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: !current });
      } catch (e) {
        console.warn('DIG Extension: toggle-dig-toolbar command failed', e);
      }
    });
  }
} catch { /* chrome.commands unavailable in some contexts */ }

// Live omnibox suggestions as the user types (#291): a `setDefaultSuggestion` line describing what
// Enter will do + the single best autocomplete row, from the SHARED classifier. Malformed / empty
// input yields a helpful default with no rows (never throws). Descriptions are XML-escaped upstream.
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const { defaultSuggestion, suggestions } = omniboxSuggestions(text);
  try {
    chrome.omnibox.setDefaultSuggestion(defaultSuggestion);
  } catch {
    /* setDefaultSuggestion is best-effort */
  }
  suggest(suggestions);
});

// #362 Tier 4 — redirect the DIG-search sentinel (the search provider's search_url on dig.net) to the
// in-extension resolver page BEFORE the request leaves the browser, so a DIG-search query never
// round-trips to a third party (bounce-free). A dynamic declarativeNetRequest rule is registered at
// startup: its `regexSubstitution` embeds the concrete extension id (only known at runtime) and
// preserves the `?q=…` query. Best-effort — the `webNavigation` sentinel catch above is the fallback
// if the DNR redirect is unavailable.
const DIG_SEARCH_DNR_RULE_ID = 3620;
async function registerDigSearchRedirect() {
  try {
    if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
    const resolver = chrome.runtime.getURL(DIG_SEARCH_RESOLVER_PAGE); // chrome-extension://<id>/dig-search.html
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DIG_SEARCH_DNR_RULE_ID],
      addRules: [
        {
          id: DIG_SEARCH_DNR_RULE_ID,
          priority: 1,
          action: { type: 'redirect', redirect: { regexSubstitution: `${resolver}?q=\\1` } },
          condition: {
            regexFilter: '^https?://(?:www\\.)?dig\\.net/dig-search\\?(?:[^#]*&)?q=([^&#]*)',
            resourceTypes: ['main_frame'],
          },
        },
      ],
    });
  } catch (e) {
    console.warn('DIG Extension: could not register DIG-search redirect rule', e);
  }
}
void registerDigSearchRedirect();

// ============================================================================
// Search Engine Management
// ============================================================================

// Default search engine configuration
const DEFAULT_SEARCH_ENGINE = {
  name: 'DIG Network Search',
  keyword: 'dig',
  faviconUrl: chrome.runtime.getURL('src/favicon.png'),
  searchUrl: 'https://rpc.dig.net/?urn=%s' // Default to rpc.dig.net
};

// Get custom search URL from storage or use default
async function getSearchUrl() {
  const result = await chrome.storage.local.get(['search.url', 'search.enabled']);
  if (result['search.enabled'] && result['search.url']) {
    return result['search.url'];
  }
  return DEFAULT_SEARCH_ENGINE.searchUrl;
}

// Add or update custom search engine
async function addCustomSearchEngine() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const searchUrl = await getSearchUrl();
    const result = await chrome.storage.local.get(['search.name', 'search.keyword']);
    
    const searchEngineName = result['search.name'] || DEFAULT_SEARCH_ENGINE.name;
    const searchKeyword = result['search.keyword'] || DEFAULT_SEARCH_ENGINE.keyword;
    
    // Check if search engine already exists
    const engines = await chrome.search.get();
    const existingEngine = engines.find(e => e.name === searchEngineName);
    
    if (existingEngine) {
      // Remove existing engine first (Chrome doesn't support updating)
      try {
        await chrome.search.remove({ name: searchEngineName });
      } catch (e) {
        console.warn('DIG Extension: Could not remove existing search engine:', e);
      }
    }
    
    // Add the new search engine
    await chrome.search.add({
      name: searchEngineName,
      keyword: searchKeyword,
      faviconUrl: DEFAULT_SEARCH_ENGINE.faviconUrl,
      searchUrl: searchUrl
    });
    
    console.log('DIG Extension: Custom search engine added:', searchEngineName);
    return { success: true, name: searchEngineName };
  } catch (error) {
    console.error('DIG Extension: Failed to add custom search engine:', error);
    return { success: false, error: error.message };
  }
}

// Get current default search engine
async function getDefaultSearchEngine() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const engines = await chrome.search.get();
    const defaultEngine = engines.find(e => e.isDefault);
    return { success: true, engine: defaultEngine };
  } catch (error) {
    console.error('DIG Extension: Failed to get default search engine:', error);
    return { success: false, error: error.message };
  }
}

// Check if DIG search engine is set as default
async function isDigSearchDefault() {
  try {
    // Check if chrome.search API is available
    if (!chrome.search || typeof chrome.search.get !== 'function') {
      console.warn('DIG Extension: chrome.search API is not available');
      return { success: false, error: 'Search API not available' };
    }
    
    const result = await chrome.storage.local.get(['search.name']);
    const searchEngineName = result['search.name'] || DEFAULT_SEARCH_ENGINE.name;
    const engines = await chrome.search.get();
    const defaultEngine = engines.find(e => e.isDefault);
    
    return {
      success: true,
      isDefault: defaultEngine && defaultEngine.name === searchEngineName,
      defaultEngine: defaultEngine ? defaultEngine.name : null
    };
  } catch (error) {
    console.error('DIG Extension: Failed to check if DIG search is default:', error);
    return { success: false, error: error.message };
  }
}

// Handle search engine management messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'addSearchEngine') {
    (async () => {
      const result = await addCustomSearchEngine();
      sendResponse(result);
    })();
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'getDefaultSearchEngine') {
    (async () => {
      const result = await getDefaultSearchEngine();
      sendResponse(result);
    })();
    return true;
  }
  
  if (message.action === 'isDigSearchDefault') {
    (async () => {
      const result = await isDigSearchDefault();
      sendResponse(result);
    })();
    return true;
  }
  
  if (message.action === 'updateSearchConfig') {
    // Save search configuration
    const storageData = {};
    if (message.name) storageData['search.name'] = message.name;
    if (message.keyword) storageData['search.keyword'] = message.keyword;
    if (message.url) storageData['search.url'] = message.url;
    if (message.enabled !== undefined) storageData['search.enabled'] = message.enabled;
    
    chrome.storage.local.set(storageData).then(async () => {
      // Re-add search engine with new config
      const result = await addCustomSearchEngine();
      sendResponse(result);
    });
    return true;
  }
  
  return false;
});

// Add search engine on extension install/startup
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['search.enabled']);
  if (result['search.enabled'] !== false) {
    // Default to enabled, add search engine
    await addCustomSearchEngine();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const result = await chrome.storage.local.get(['search.enabled']);
  if (result['search.enabled'] !== false) {
    await addCustomSearchEngine();
  }
});

