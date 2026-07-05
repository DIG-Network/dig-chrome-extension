// ES module service worker — background.js is loaded with "type": "module" in manifest.json.
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
import { parseURN } from './dig-urn.mjs';

// Branded, plain-language chia:// error page (white theme; never leaks crypto strings).
import { buildErrorPageHtml } from './error-page.mjs';
// Catalogued, stable chia:// loader error codes (DIG_ERR_*) + the coded-error envelope.
// Aligned with docs.dig.net static/error-codes.json `dig-loader` surface.
import { DIG_ERR, makeError } from './error-codes.mjs';
// The versioned message catalogue: the frozen ACTIONS enum + getCapabilities self-description.
import { ACTIONS, buildCapabilities, OFFSCREEN_TARGET } from './messages.mjs';
// Self-custody session logic (#56): the offscreen-vault coordination decisions (pure; no chrome.*).
import {
  KEYSTORE_KEY,
  SETTINGS_KEY,
  ACTIVE_WALLET_KEY,
  UNLOCK_EXPIRY_KEY,
  BALANCES_CACHE_KEY,
  LOCK_STATE,
  SCAN_GAP_LIMIT,
  isCustodyAction,
  resolveTtlMinutes,
  resolveCoinsetUrl,
  computeUnlockExpiry,
  deriveLockState,
} from './custody-session.mjs';
// Watched-CAT parsing (asset ids to scan) — the same shared helper the wallet UI uses.
import { parseWatchedCats } from './wallet-assets.mjs';
// dig-node install prompt + "dig-node required" error mapping (universal installer link).
import { digNodeInstallPrompt, isDigNodeRequiredError } from './dig-node-status.mjs';

// Shared dig-node host config (one parser/default for the server.host key) + the local-node
// resolution order (dig.local preferred, localhost:port fallback) and reachability probe.
import {
  parseServerHost as parseDigNodeHost,
  resolveDigNode,
} from './server-config.mjs';

// DIG Control Panel decision logic (the dig://control parity surface): detect a local dig-node
// → manage vs install, the catalogued control.* method names, and the honest hosted-RPC
// fallback. Byte-consistent with the dig-node control RPC contract (dig-companion control.rs).
import {
  decideControlView,
  CONTROL_METHODS,
  isUnauthorizedControlResult,
} from './dig-control.mjs';

// DIG Shields per-resource proof LEDGER (#134, mirrored from the browser): the per-tab/
// per-capsule accumulator of inclusion-proof verdicts the Shield action lists.
import { LedgerStore, groupLedger } from './dig-ledger.mjs';

// Wallet broker: per-origin consent + CHIP-0002 routing for the injected window.chia
// provider, backed by WalletConnect→Sage. The broker core (consent gate, method
// validation, envelope shaping) is in wallet-broker.mjs; the live WC session runs in the
// popup page (MV3 SWs can't hold a relay socket), so the SW-side transport proxies
// requests to the popup when it's open and otherwise reports "not connected".
import {
  brokerRequest,
  getConnection as getWalletConnection,
  isOriginApproved,
  setOriginApproval,
} from './wallet-broker.mjs';

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

// Resolve the local dig-node base URL (dig.local preferred, localhost:<port> fallback),
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
 * Mirrors the shared resolution order in server-config.mjs (dig.local → localhost:port);
 * here the chosen base becomes the JSON-RPC POST endpoint (trailing slash).
 */
async function getRpcEndpoint() {
  const localBase = await resolveLocalDigNode();
  if (localBase) return localBase.endsWith('/') ? localBase : localBase + '/';
  return getHostedRpcEndpoint();
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

// ---- Wallet transport (SW side) -----------------------------------------------
// The live WalletConnect SignClient runs in the popup page (it needs IndexedDB + a
// long-lived relay socket, which an MV3 service worker cannot keep alive). The SW
// brokers each window.chia request through this transport, which proxies to the popup
// via chrome.runtime.sendMessage. If the popup isn't open, there is no live session, so
// isConnected() reports the persisted connection flag and request() asks the popup
// (failing cleanly when it's closed — the provider then surfaces "pair Sage in the popup").
const walletTransport = {
  async isConnected() {
    const conn = await getWalletConnection(chrome.storage.local);
    return !!(conn && conn.connected);
  },
  request({ method, params }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      try {
        chrome.runtime.sendMessage(
          { action: 'walletProxyToPopup', method, params },
          (response) => {
            if (chrome.runtime.lastError) {
              // No popup listening → no live relay session.
              done(reject, new Error('Wallet popup is not open — open the extension and pair Sage'));
              return;
            }
            if (!response) { done(reject, new Error('No response from wallet')); return; }
            if (response.error) { done(reject, new Error(response.error)); return; }
            done(resolve, response.data);
          }
        );
      } catch (e) {
        done(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });
  },
};

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
 * code to distinguish the expected UNAUTHORIZED (-32020) reply (node present but the mutating
 * control surface is token-gated, and the extension can't read the on-disk control token) from
 * a real failure.
 *
 * The dig-node reflects the chrome-extension:// CORS origin and allows the control-token header
 * (dig-companion/src/server.rs), so the request reaches the loopback node. We do not (and
 * cannot) populate the X-Dig-Control-Token header — an MV3 extension has no filesystem access —
 * so a node will answer mutating control.* with UNAUTHORIZED, which the caller handles honestly.
 */
async function controlRpc(endpoint, method, params) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    // ('latest') resolves to the store's current/latest capsule.
    const root        = parsed.roothash || 'latest';
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

    // 4. Fetch ciphertext (chunked, up to 3 MiB windows)
    const { ciphertext, proof, chunkLens } = await fetchVerified(ep, storeId, rk, root);

    // 5. Verify merkle inclusion proof (non-throwing; decoys return false)
    let verified = false;
    try {
      verified = !!dig.verifyInclusion(ciphertext, proof, root);
    } catch {
      verified = false;
    }

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
// SAME name, default (localhost:8080 — the dig-node port), and parse rules.
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

// isDigLocalResolvable removed: all content is served via rpc.dig.net RPC POST.
// No localhost/dig.local GET probing needed.

// Stub retained only so any surviving reference doesn't crash — always returns false.
// (All call-sites that acted on a true result have been removed.)
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

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Hold the self-custody wallet key in memory and run Argon2id + AES-GCM decryption off the ephemeral service worker.',
  });
  try { await creatingOffscreen; } catch { /* another caller may have created it */ } finally { creatingOffscreen = null; }
}

/** Forward one request to the offscreen keystore vault (creating the doc if needed). */
async function callVault(request) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, request });
}

/** Ask the vault (only if it exists) whether it currently holds a decrypted key. */
async function vaultHasKey() {
  if (!(await hasOffscreenDocument())) return false;
  try {
    const res = await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, request: { op: 'getVaultState' } });
    return !!(res && res.hasKey);
  } catch { return false; }
}

async function readKeystore() {
  const out = await chrome.storage.local.get(KEYSTORE_KEY);
  return out[KEYSTORE_KEY] || null;
}

async function readWalletSettings() {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  return out[SETTINGS_KEY] || {};
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

/** Compute the tri-state lock snapshot the UI reads; also enforces a lapsed TTL (locks the vault). */
async function getLockStateSnapshot() {
  const [record, sess, active, hasKey] = await Promise.all([
    readKeystore(),
    chrome.storage.session.get(UNLOCK_EXPIRY_KEY),
    chrome.storage.local.get(ACTIVE_WALLET_KEY),
    vaultHasKey(),
  ]);
  const unlockExpiry = sess[UNLOCK_EXPIRY_KEY] || null;
  const lockState = deriveLockState({ hasKeystore: !!record, hasKeyInVault: hasKey, unlockExpiry, now: Date.now() });
  if (record && hasKey && lockState === LOCK_STATE.LOCKED) await lockVaultNow(); // TTL lapsed
  return { lockState, activeWalletId: active[ACTIVE_WALLET_KEY] || null, unlockExpiry };
}

/** Handle one custody action end-to-end (SW ↔ offscreen ↔ storage). Returns the reply payload. */
async function handleCustodyAction(message) {
  switch (message.action) {
    case ACTIONS.getLockState:
      return getLockStateSnapshot();
    case ACTIONS.lockWallet:
      await lockVaultNow();
      return { lockState: LOCK_STATE.LOCKED };
    case ACTIONS.createWallet: {
      const res = await callVault({ op: 'createWallet', password: message.password, label: message.label, strong: message.strong });
      if (!res || res.success === false) return res || { success: false, code: 'CUSTODY_ERROR', message: 'create failed' };
      await chrome.storage.local.set({ [KEYSTORE_KEY]: res.record, [ACTIVE_WALLET_KEY]: message.label || 'main' });
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, mnemonic: res.mnemonic, usedFallback: res.usedFallback };
    }
    case ACTIONS.importWallet: {
      const res = await callVault({ op: 'importWallet', mnemonic: message.mnemonic, password: message.password, label: message.label, strong: message.strong });
      if (!res || res.success === false) return res || { success: false, code: 'CUSTODY_ERROR', message: 'import failed' };
      await chrome.storage.local.set({ [KEYSTORE_KEY]: res.record, [ACTIVE_WALLET_KEY]: message.label || 'main' });
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, usedFallback: res.usedFallback };
    }
    case ACTIONS.unlockWallet: {
      const record = await readKeystore();
      if (!record) return { success: false, code: 'NO_WALLET', message: 'no wallet to unlock' };
      const res = await callVault({ op: 'unlockWallet', password: message.password, record });
      if (!res || res.success === false) return res || { success: false, code: 'UNLOCK_FAILED', message: 'unlock failed' };
      await startUnlockWindow();
      return { lockState: LOCK_STATE.UNLOCKED, usedFallback: res.usedFallback };
    }
    case ACTIONS.revealPhrase: {
      const record = await readKeystore();
      if (!record) return { success: false, code: 'NO_WALLET', message: 'no wallet' };
      return callVault({ op: 'revealPhrase', password: message.password, record });
    }
    case ACTIONS.getReceiveAddress:
      return callVault({ op: 'getReceiveAddress' });
    case ACTIONS.getCustodyBalances: {
      const settings = await readWalletSettings();
      const coinsetUrl = resolveCoinsetUrl(settings);
      const { [WATCHED_CATS_KEY]: watchedRaw } = await chrome.storage.local.get(WATCHED_CATS_KEY);
      const watchedCats = parseWatchedCats(watchedRaw).map((c) => c.assetId);
      const res = await callVault({ op: 'scanBalances', watchedCats, gapLimit: SCAN_GAP_LIMIT, coinsetUrl });
      if (res && res.success !== false && res.balances) {
        await chrome.storage.local.set({ [BALANCES_CACHE_KEY]: { balances: res.balances, at: Date.now() } });
        return { balances: res.balances, cached: false };
      }
      // Scan failed (offline / locked) — fall back to the last cached snapshot (cached-first).
      const { [BALANCES_CACHE_KEY]: cache } = await chrome.storage.local.get(BALANCES_CACHE_KEY);
      if (cache && cache.balances) return { balances: cache.balances, cached: true };
      return res || { success: false, code: 'CUSTODY_ERROR', message: 'balance scan failed' };
    }
    default:
      return { success: false, code: 'CUSTODY_ERROR', message: 'unknown custody action' };
  }
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
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'idle' || state === 'locked') lockVaultNow();
  });
} catch { /* idle unavailable */ }

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
  if (message.action === 'toggleExtension') {
    // State is updated in popup.js; no redirect rules to update (all content via RPC)
    console.log('Extension toggled:', message.enabled);
    return false; // Not async
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

  // window.chia RPC from the content-script bridge (DIG_WALLET_REQUEST). Routes through
  // the broker (per-origin consent gate + WC→Sage transport). The committed page origin
  // is supplied by the content script. Returns the {status, body} envelope the provider
  // expects. NOTE: sender.origin (when present) is the unspoofable origin; we prefer it
  // over the message-supplied origin so a compromised content script can't lie.
  if (message.action === 'walletRpc') {
    const origin = (sender && sender.origin) || message.origin;
    (async () => {
      const env = await brokerRequest(
        {
          storage: chrome.storage.local,
          transport: walletTransport,
          // For a not-yet-approved origin, record it as pending so the popup can prompt;
          // do NOT auto-approve (the user approves in the popup → connect() resolves on poll).
          requestConsent: async (o) => {
            const approved = await isOriginApproved(chrome.storage.local, o);
            if (!approved) await recordPendingOrigin(o);
            return approved;
          },
        },
        message.method,
        message.params || {},
        origin
      );
      try { sendResponse(env); } catch { /* port closed */ }
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

  // Popup: is a local dig-node reachable? Resolves the dig.local → localhost:port try-list
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
          // UNAUTHORIZED (-32020) — the expected outcome for the token-less extension.
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

  // Self-description: machine-readable capability/version surface. Returns the message
  // protocol version, the full ACTIONS list, the wallet method surface, and the error-code
  // catalogue so an agent can introspect the whole extension contract with one call.
  if (message.action === ACTIONS.getCapabilities) {
    let version = 'unknown';
    try { version = chrome.runtime.getManifest().version || 'unknown'; } catch { /* ignore */ }
    sendResponse(buildCapabilities(version));
    return false;
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
  
  try {
    // Extract URN from chia:// URL (remove chia:// prefix)
    const urn = digUrl.replace(/^chia:\/\//, '');
    
    // Redirect to dig-viewer.html with URN parameter
    // The viewer will fetch content via RPC and embed it
    const viewerUrl = chrome.runtime.getURL(`dig-viewer.html?urn=${encodeURIComponent(urn)}`);
    
    console.log('DIG Extension: Redirecting to viewer:', viewerUrl);
    
    // Navigate to viewer page
    await chrome.tabs.update(tabId, {
      url: viewerUrl
    });
    
    console.log('DIG Extension: Successfully redirected to viewer');
  } catch (error) {
    console.error('DIG Extension: Error in handleDigUrlNavigation:', error);
    await chrome.tabs.update(tabId, { url: digErrorPageUrl(digUrl, error) });
  }
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
  { url: [{ schemes: ['chia', 'http', 'https'] }] }
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

// Omnibox handler - allows users to type "dig" followed by URN or search query in address bar
chrome.omnibox.onInputEntered.addListener(
  async (text, disposition) => {
    console.log('DIG Extension: Omnibox input received:', text);
    
    const trimmedText = text.trim();
    
    // Check if it's a chia:// URL or URN
    if (trimmedText.startsWith('chia://') || trimmedText.startsWith('urn:dig:') || /^[a-f0-9]{64}/i.test(trimmedText)) {
      // Handle as chia:// URL
      let digUrl = trimmedText;
      
      // If it doesn't start with chia://, add it
      if (!digUrl.startsWith('chia://')) {
        // If it starts with "urn:dig:", add "chia://" prefix
        if (digUrl.startsWith('urn:dig:')) {
          digUrl = 'chia://' + digUrl;
        } else {
          // Otherwise, assume it's a URN and add both prefixes
          digUrl = 'chia://urn:dig:' + digUrl;
        }
      }
      
      console.log('DIG Extension: Omnibox converted to:', digUrl);
      
      // Get the current tab or create a new one based on disposition
      if (disposition === 'currentTab') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          await redirectDigUrlToLocalhost(tabs[0].id, digUrl);
        }
      } else {
        // Open in new tab - use RPC to get data URL
        try {
          const rpcResult = await fetchContentViaRPC(digUrl);
          await chrome.tabs.create({ url: rpcResult.dataUrl });
        } catch (error) {
          console.error('DIG Extension: RPC failed for new tab:', error);
          await chrome.tabs.create({ url: digErrorPageUrl(digUrl, error) });
        }
      }
    } else {
      // Handle as search query - use custom search engine if enabled
      const result = await chrome.storage.local.get(['search.enabled', 'search.url']);
      const searchEnabled = result['search.enabled'] !== false;
      
      if (searchEnabled && result['search.url']) {
        // Use custom search URL
        const searchUrl = result['search.url'].replace('%s', encodeURIComponent(trimmedText));
        console.log('DIG Extension: Omnibox search query:', trimmedText, '->', searchUrl);
        
        if (disposition === 'currentTab') {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            await chrome.tabs.update(tabs[0].id, { url: searchUrl });
          }
        } else {
          await chrome.tabs.create({ url: searchUrl });
        }
      } else {
        // Fallback: try to use Chrome's search API
        try {
          const searchUrl = await getSearchUrl();
          const finalUrl = searchUrl.replace('%s', encodeURIComponent(trimmedText));
          
          if (disposition === 'currentTab') {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
              await chrome.tabs.update(tabs[0].id, { url: finalUrl });
            }
          } else {
            await chrome.tabs.create({ url: finalUrl });
          }
        } catch (error) {
          console.error('DIG Extension: Failed to handle search query:', error);
          // Last resort: use Google
          const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmedText)}`;
          if (disposition === 'currentTab') {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
              await chrome.tabs.update(tabs[0].id, { url: googleUrl });
            }
          } else {
            await chrome.tabs.create({ url: googleUrl });
          }
        }
      }
    }
  }
);

// Also provide suggestions as user types
chrome.omnibox.onInputChanged.addListener(
  async (text, suggest) => {
    // Provide helpful suggestions
    const suggestions = [];
    
    if (text.trim().length === 0) {
      suggestions.push({
        content: 'chia://urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/',
        description: 'Example: chia://urn:dig:chia:.../resource'
      });
    } else {
      // If user is typing a URN, suggest the full chia:// URL
      let suggestedUrl = text.trim();
      if (!suggestedUrl.startsWith('chia://')) {
        if (suggestedUrl.startsWith('urn:dig:')) {
          suggestedUrl = 'chia://' + suggestedUrl;
        } else {
          suggestedUrl = 'chia://urn:dig:' + suggestedUrl;
        }
      }
      
      suggestions.push({
        content: suggestedUrl,
        description: `Open: ${suggestedUrl}`
      });
    }
    
    suggest(suggestions);
  }
);

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

