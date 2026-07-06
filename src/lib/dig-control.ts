/**
 * DIG Control Panel — the extension equivalent of the native DIG Browser's dig://control
 * "My Node" surface. ONE place that decides what the Control Panel shows and which endpoint it
 * drives, kept byte-consistent with the dig-node control RPC contract.
 *
 * # What the Control Panel does (parity with dig://control)
 *
 * It detects a LOCAL dig-node (the SAME resolution order the read path uses — `dig.local`
 * preferred, then `localhost:<port>`, via server-config.mjs `resolveDigNode`) and branches:
 *
 *   - **manage** — a local dig-node answered → show the node-management surface keyed on the
 *     `control.*` RPCs ({@link CONTROL_METHODS}): status, config, cache, hosted stores, §21 sync.
 *   - **install** — no local dig-node → a landing page encouraging download + install of the
 *     universal dig-node installer. The read path transparently FALLS BACK to the hosted
 *     {@link HOSTED_RPC_FALLBACK} (rpc.dig.net), so chia:// content keeps resolving without a node.
 *
 * # Honest status under MV3 (why the extension can't fully drive control.*)
 *
 * The dig-node gates the MUTATING `control.*` methods behind a local control token (the
 * {@link CONTROL_TOKEN_HEADER} header, or `params._control_token`) read from
 * `<config_dir>/control-token`. A browser extension has NO filesystem access, so it cannot read
 * that token — the node answers control.* with UNAUTHORIZED ({@link CONTROL_ERR}.UNAUTHORIZED,
 * -32030). The extension therefore drives only the OPEN surface to show read-only node status
 * (and classifies an UNAUTHORIZED reply via {@link isUnauthorizedControlResult}), then deep-links
 * full management to the native DIG Browser's dig://control, which CAN present the token. This
 * mirrors the README parity matrix: control endpoint NAMES + detection order stay identical to
 * the browser; only the in-extension capability is honestly scoped. Never show a control as
 * working that the extension cannot actually drive.
 *
 * The dig-node DOES reflect the `chrome-extension://` CORS origin and allows the control-token
 * header (dig-node-service/src/server.rs), so the extension can reach the loopback node — the only
 * gap is the token, by design.
 *
 * Plain ES module (no chrome.* / DOM): importable by background.js, the popup, and unit-testable
 * under `node --test`. The node resolver + fetch are injectable so the branch is fully testable.
 *
 * Source of truth for the catalogued names/codes (after #209 moved the node out of dig-companion):
 * modules/apps/dig-node/crates/dig-node-service/src/control.rs +
 * modules/apps/dig-node/crates/dig-node-service/src/meta.rs (drift-guarded by that crate's
 * openrpc_drift_guard.rs). Keep this mirror in lock-step with them.
 */

import { DIG_INSTALLER_URL } from './dig-node-status';

/** The hosted DIG RPC the read path transparently falls back to when no local node is present. */
export const HOSTED_RPC_FALLBACK = 'https://rpc.dig.net/';

/**
 * The request header the dig-node expects the local control token in (mirrors
 * `params._control_token`). Defined here so the extension's control bridge names it identically
 * to the node, even though the extension cannot READ the token to populate it. Source:
 * dig-node/crates/dig-node-service/src/control.rs `CONTROL_TOKEN_HEADER`.
 */
export const CONTROL_TOKEN_HEADER = 'X-Dig-Control-Token';

/**
 * The catalogued CONTROL/admin JSON-RPC methods the dig-node serves (the node-management surface
 * the DIG Browser's dig://control drives). Byte-identical to the `dispatch_control` arms in
 * dig-node/crates/dig-node-service/src/control.rs — change them together. Frozen so a caller cannot mutate the list.
 * @readonly
 */
export const CONTROL_METHODS = Object.freeze([
  'control.status',
  'control.config.get',
  'control.config.setUpstream',
  'control.cache.get',
  'control.cache.setCap',
  'control.cache.clear',
  'control.hostedStores.list',
  'control.hostedStores.pin',
  'control.hostedStores.unpin',
  'control.hostedStores.status',
  'control.sync.status',
  'control.sync.trigger',
  // Subscription + peer surface (dig-node-service adds these to dispatch_control).
  'control.subscribe',
  'control.unsubscribe',
  'control.listSubscriptions',
  'control.peerStatus',
]);

/**
 * The stable control-plane error codes the dig-node mints (dig-node-service/src/meta.rs
 * `ErrorCode`). The extension branches on these numeric codes (and the UPPER_SNAKE `data.code`),
 * never on prose.
 * @readonly
 */
export const CONTROL_ERR = Object.freeze({
  /** control.* called without a valid local control token (the extension's expected reply). */
  UNAUTHORIZED: -32030,
  /** A control op the node build can't perform (e.g. §21 sync with no identity). */
  NOT_SUPPORTED: -32031,
  /** A control op failed at runtime. */
  CONTROL_ERROR: -32032,
});

/**
 * Is `method` a CONTROL/admin method (the gated `control.*` namespace)? Matches the dig-node's
 * own prefix gate (`is_control_method` in control.rs) so the classification can't drift.
 * @param {string|null|undefined} method
 * @returns {boolean}
 */
export function isControlMethod(method: unknown): boolean {
  return typeof method === 'string' && method.startsWith('control.');
}

/**
 * True when a dig-node JSON-RPC response is the UNAUTHORIZED control-gate reply — i.e. the node is
 * present and answered, but rejected a `control.*` call because no valid control token was
 * presented (the expected outcome for the token-less extension). The Control Panel uses this to
 * show "node detected — manage it in the DIG Browser" rather than a transient-error state.
 *
 * @param {{error?:{code?:number}}|null|undefined} resp a parsed JSON-RPC response object
 * @returns {boolean}
 */
export function isUnauthorizedControlResult(
  resp: { error?: { code?: number; [k: string]: unknown } | null; [k: string]: unknown } | null | undefined,
): boolean {
  return !!(resp && resp.error && resp.error.code === CONTROL_ERR.UNAUTHORIZED);
}

/**
 * Decide what the Control Panel renders. PURE w.r.t. its injected dependencies — the only effect
 * is calling `resolveNode()`.
 *
 * @param {object} opts
 * @param {() => Promise<string|null>} opts.resolveNode resolves the reachable local dig-node base
 *   URL (e.g. `http://dig.local`) or `null` if none is reachable. In production this is
 *   server-config.mjs `resolveDigNode` bound to the configured host.
 * @param {string} [opts.hostedFallback] the hosted read fallback (defaults to
 *   {@link HOSTED_RPC_FALLBACK}); the options page may override it.
 * @returns {Promise<{
 *   mode: 'manage'|'install',
 *   localNode: boolean,
 *   base: string|null,
 *   controlEndpoint: string|null,
 *   readFallback: string,
 * }>}
 *   - `mode` — `manage` when a local node answered, else `install`.
 *   - `localNode` — whether a local node is reachable.
 *   - `base` — the reachable local node base URL, or `null`.
 *   - `controlEndpoint` — the JSON-RPC POST endpoint for control.* (the base with a trailing
 *     slash), or `null` when no node (control.* is unavailable without a node).
 *   - `readFallback` — the hosted endpoint the READ path uses when no local node is present
 *     (always reported so the UI can state honestly that reads keep working).
 */
export async function decideControlView({
  resolveNode,
  hostedFallback = HOSTED_RPC_FALLBACK,
}: {
  resolveNode?: () => Promise<string | null>;
  hostedFallback?: string;
} = {}): Promise<{
  mode: 'manage' | 'install';
  localNode: boolean;
  base: string | null;
  controlEndpoint: string | null;
  readFallback: string;
}> {
  let base: string | null = null;
  try {
    base = (await resolveNode?.()) || null;
  } catch {
    // A thrown probe means we could not confirm a node — honest default: treat as absent.
    base = null;
  }

  if (base) {
    const controlEndpoint = base.endsWith('/') ? base : base + '/';
    return {
      mode: 'manage',
      localNode: true,
      base,
      controlEndpoint,
      readFallback: hostedFallback,
    };
  }

  return {
    mode: 'install',
    localNode: false,
    base: null,
    controlEndpoint: null,
    readFallback: hostedFallback,
  };
}

/**
 * Build the PURE view model the Control Panel renders, from a `getControlStatus` response. This
 * keeps the manage-vs-install presentation logic testable without a DOM — the popup renderer is
 * thin glue over this. Honest by construction: `nodeOnline` reflects an actually-reachable node;
 * `hasStats` is true only when the node returned a `control.status` payload; the install path
 * always carries the read-fallback line so the UI states that reads keep working without a node.
 *
 * @param {object} view a `getControlStatus` response
 *   ({mode, localNode, base, controlEndpoint, readFallback, status, authRequired}).
 * @returns {{
 *   mode:'manage'|'install', nodeOnline:boolean, base:string|null, authRequired:boolean,
 *   hasStats:boolean,
 *   stats:{hostedStores:(number|string), cachedCapsules:(number|string),
 *          cacheUsedBytes:(number|null), syncOn:boolean}|null,
 *   upstream:string, deepLinkBrowser:boolean, note:string,
 *   install:{title,body,installLabel,installUrl}, readFallbackLine:string,
 * }}
 */
/** The read-only `control.status` payload the node returns (only the fields this view model reads). */
export interface ControlStatusPayload {
  hosted_store_count?: number;
  pinned_store_count?: number;
  cached_capsule_count?: number;
  cache?: { used_bytes?: number } | null;
  sync?: { available?: boolean } | null;
  upstream?: string;
  /** The node may return additional diagnostic fields we don't model. */
  [key: string]: unknown;
}

/** A `getControlStatus` response as consumed by {@link controlPanelViewModel}. */
export interface ControlView {
  mode?: string;
  localNode?: boolean;
  base?: string | null;
  controlEndpoint?: string | null;
  readFallback?: string;
  status?: ControlStatusPayload | null;
  authRequired?: boolean;
}

export function controlPanelViewModel(view: ControlView | null | undefined) {
  const v: ControlView = view || {};
  const readFallback = v.readFallback || HOSTED_RPC_FALLBACK;

  if (v.mode === 'manage' && v.localNode) {
    const s = v.status || null;
    const hasStats = !!s;
    const stats = hasStats
      ? {
          hostedStores: s.hosted_store_count ?? s.pinned_store_count ?? '—',
          cachedCapsules: s.cached_capsule_count ?? '—',
          cacheUsedBytes: (s.cache && typeof s.cache.used_bytes === 'number') ? s.cache.used_bytes : null,
          syncOn: !!(s.sync && s.sync.available),
        }
      : null;
    const note = v.authRequired
      ? 'Your dig-node is running — you have the full DIG experience: chia:// content resolves ' +
        'locally on your machine. Full node management (host stores, set the cache cap, trigger sync) ' +
        'needs the native DIG Browser, which can authorize node control on your machine.'
      : 'Your dig-node is running — you have the full DIG experience: chia:// content resolves ' +
        'locally on your machine (faster, private, works offline once cached). For full node ' +
        'management, use the native DIG Browser.';
    return {
      mode: 'manage',
      nodeOnline: true,
      base: v.base || null,
      authRequired: !!v.authRequired,
      hasStats,
      stats,
      upstream: (s && s.upstream) || readFallback,
      // Even an open node deep-links full (mutating) management to the native browser, since the
      // extension cannot present the on-disk control token under MV3.
      deepLinkBrowser: true,
      note,
      install: controlInstallPrompt(),
      // In manage mode reads resolve through the LOCAL node, not the hosted fallback.
      readFallbackLine: 'Reads resolve locally through your dig-node — private and fast.',
    };
  }

  return {
    mode: 'install',
    nodeOnline: false,
    base: null,
    authRequired: false,
    hasStats: false,
    stats: null,
    upstream: readFallback,
    deepLinkBrowser: true,
    note: '',
    install: controlInstallPrompt(),
    // Honest: without a node the extension is READ-ONLY through the hosted network.
    readFallbackLine: `No local dig-node detected — the extension is running in read-only mode through the hosted network (${readFallback}). Install the dig-node for the full experience.`,
  };
}

/**
 * The friendly, plain-language landing copy shown when NO local dig-node is reachable — the
 * Control Panel's "install" mode. Same installer URL as the popup's soft banner
 * (dig-node-status.mjs), but framed for the Control Panel: it explains what a node gives you
 * (host + manage content) and is honest that reads keep working via the hosted network without
 * one. NEVER includes protocol jargon.
 *
 * @returns {{title:string, body:string, installLabel:string, installUrl:string}}
 */
export function controlInstallPrompt(): { title: string; body: string; installLabel: string; installUrl: string } {
  return {
    title: 'Install the dig-node for the full experience',
    body:
      'The DIG extension works best with the dig-node installed and RUNNING on your machine — that is ' +
      'what unlocks the full experience: it resolves chia:// content locally (faster, private, works ' +
      'offline once cached) and lets you host and manage your own stores. It installs in one step on ' +
      'Windows, macOS, and Linux. Without it the extension still works, but only in read-only mode ' +
      'through the hosted network (rpc.dig.net) — you can’t host, and every read goes through DIG’s servers.',
    installLabel: 'Download the dig-node',
    installUrl: DIG_INSTALLER_URL,
  };
}
