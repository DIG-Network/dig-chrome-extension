/**
 * The extension's internal MESSAGE protocol — a single, frozen, versioned, self-describing
 * catalogue of every chrome.runtime `message.action` the background service worker handles
 * (plus the window.postMessage bridge the injected provider uses).
 *
 * Why this exists: the background SW used to expose ~24 distinct request types keyed on an
 * ad-hoc `message.action` string, each with its own undocumented request/response shape,
 * spread across ~90 KB of background.js. Nothing enumerated the names, documented the DTOs,
 * or versioned the contract — the popup, the viewer, and any agent had to read the whole
 * file to learn it. This module is the one typed source of truth (mirroring how
 * wallet-methods.mjs enumerates the wallet surface): import `ACTIONS` instead of typing the
 * raw strings, read `MESSAGE_CATALOGUE` to discover the contract, and bump
 * `MESSAGE_PROTOCOL_VERSION` whenever the shape changes.
 *
 * Plain ES module (no chrome.* / DOM) so background.js, popup.js, popup-wallet.js,
 * dig-viewer.js, options.js AND tests under `node --test` can all import it.
 */

import { WALLET_METHODS, STATE_CHANGING_METHODS } from './wallet-methods.mjs';
import { DIG_ERR } from './error-codes.mjs';

/**
 * Version of THIS message contract (the action set + their request/response shapes). Bump
 * on any breaking change so a consumer can feature-detect via the `getCapabilities` action.
 *
 * v2 (#43 / #41 SoC audit): removed `preloadResources`, `getCacheStats`, and `clearCache` —
 * the extension no longer caches resolved content (caching is a dig-node job).
 *
 * v3 (#56 self-custody): added the custody actions (`createWallet`, `importWallet`,
 * `unlockWallet`, `lockWallet`, `revealPhrase`, `getLockState`) the SW routes to the offscreen
 * keystore vault, plus the `OFFSCREEN_TARGET` discriminator for SW→offscreen messages.
 *
 * v4 (#56 balances): added `getReceiveAddress` + `getCustodyBalances` — the SW forwards them to the
 * offscreen vault, which derives (both HD schemes) and scans coinset for XCH + watched CATs.
 */
export const MESSAGE_PROTOCOL_VERSION = 4;

/**
 * Discriminator on messages the service worker forwards to the offscreen keystore vault
 * (`chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, op, ... })`). The offscreen document's
 * listener handles ONLY messages carrying this target; the SW's own `onMessage` listener ignores
 * them (they are round-trips to the vault, not requests for the SW). The decrypted key lives ONLY
 * in the offscreen document — these messages carry passwords IN and public results / the once-shown
 * mnemonic OUT, never the persisted key.
 */
export const OFFSCREEN_TARGET = 'dig-offscreen';

/**
 * Frozen enum of every `message.action` the extension routes over chrome.runtime. Each key
 * === its string value so callers can write `ACTIONS.proxyRequest` and get `"proxyRequest"`.
 *
 * Grouped by purpose for readability; the grouping is informational only.
 * @readonly
 */
export const ACTIONS = Object.freeze({
  // ── chia:// resolution ──
  proxyRequest: 'proxyRequest',
  convertDigUrl: 'convertDigUrl',
  navigateToDigUrl: 'navigateToDigUrl',
  navigateToDataUrl: 'navigateToDataUrl', // deprecated; navigates a legacy server URL
  getDataUrl: 'getDataUrl', // deprecated; returns a data: URL
  navigate: 'navigate',
  // ── extension state ──
  toggleExtension: 'toggleExtension',
  updateServerConfig: 'updateServerConfig',
  updateRpcHost: 'updateRpcHost', // background → content broadcast (not handled by background)
  // ── wallet (window.chia broker) ──
  walletRpc: 'walletRpc',
  walletConsent: 'walletConsent',
  // ── self-custody wallet (#56): keystore ops the SW routes to the offscreen vault ──
  createWallet: 'createWallet',
  importWallet: 'importWallet',
  unlockWallet: 'unlockWallet',
  lockWallet: 'lockWallet',
  revealPhrase: 'revealPhrase',
  getLockState: 'getLockState',
  getReceiveAddress: 'getReceiveAddress',
  getCustodyBalances: 'getCustodyBalances',
  // ── verification + node status ──
  reportVerification: 'reportVerification',
  getVerification: 'getVerification',
  getDigNodeStatus: 'getDigNodeStatus',
  // ── DIG Shields (per-resource proof ledger) — mirrors the browser dig://shields #134 ──
  recordLedgerEntry: 'recordLedgerEntry',
  getShieldLedger: 'getShieldLedger',
  // ── DIG Control Panel (node management) — mirrors the browser dig://control ──
  getControlStatus: 'getControlStatus',
  // ── diagnostics ──
  reportError: 'reportError',
  reportSuccess: 'reportSuccess',
  // ── search engine ──
  addSearchEngine: 'addSearchEngine',
  getDefaultSearchEngine: 'getDefaultSearchEngine',
  isDigSearchDefault: 'isDigSearchDefault',
  updateSearchConfig: 'updateSearchConfig',
  // ── self-description ──
  getCapabilities: 'getCapabilities',
});

/**
 * The window.postMessage bridge between the injected MAIN-world provider (dig-provider.js)
 * and the content-script bridge (content.js). Distinct from chrome.runtime actions because
 * it crosses the page↔extension boundary, not the content↔background one.
 * @readonly
 */
export const BRIDGE = Object.freeze({
  /** page → content: a CHIP-0002 wallet RPC, `{ type, id, method, params }`. */
  WALLET_REQUEST: 'DIG_WALLET_REQUEST',
  /** content → page: the wallet envelope reply, `{ type, id, status, body, error }`. */
  WALLET_RESPONSE: 'DIG_WALLET_RESPONSE',
});

// Shorthand for documenting a coded-error response in the catalogue below. The loader paths
// (proxyRequest/convertDigUrl/getDataUrl) return `{ success:false, code, message }` where
// `code` is one of the DIG_ERR_* values (see error-codes.mjs).
const CODED_ERROR = `{ success:false, code:DIG_ERR_*, message } on failure (codes: ${Object.values(DIG_ERR).join(', ')})`;

/**
 * Self-describing catalogue: one entry per action with a one-line summary and the request /
 * response field shapes (as JSDoc-style strings — this is documentation an agent can read,
 * not a runtime validator). Kept in lockstep with the handlers in background.js; the
 * messages.test.mjs drift test fails if an action is added without an entry.
 * @readonly
 */
export const MESSAGE_CATALOGUE = Object.freeze({
  [ACTIONS.proxyRequest]: {
    summary: 'Resolve a chia:// URL to verified, decrypted content (the primary read path, no caching).',
    request: '{ action, url:string /* chia://… */ }',
    response: `{ success:true, data:dataUrl, contentType:string, verified?:boolean } | ${CODED_ERROR}`,
  },
  [ACTIONS.convertDigUrl]: {
    summary: 'Resolve a chia:// URL and return a data: URL (one-shot, no caching).',
    request: '{ action, url:string }',
    response: `{ url:dataUrl, dataUrl:dataUrl } | ${CODED_ERROR}`,
  },
  [ACTIONS.navigateToDigUrl]: {
    summary: 'Open a chia:// URL in the dig-viewer for the sender (or active) tab.',
    request: '{ action, url:string }',
    response: `{ success:true, url:viewerUrl } | ${CODED_ERROR}`,
  },
  [ACTIONS.navigateToDataUrl]: {
    summary: 'DEPRECATED — navigate a tab to a legacy content-server URL.',
    request: '{ action, dataUrl:string }',
    response: 'none (navigation closes the port)',
  },
  [ACTIONS.getDataUrl]: {
    summary: 'DEPRECATED — resolve a chia:// URL to a data: URL (use proxyRequest).',
    request: '{ action, url:string }',
    response: `{ dataUrl:string, url:string } | ${CODED_ERROR}`,
  },
  [ACTIONS.navigate]: {
    summary: 'Navigate the active tab to an arbitrary URL.',
    request: '{ action, url:string }',
    response: '{ success:boolean, error?:string }',
  },
  [ACTIONS.toggleExtension]: {
    summary: 'Toggle chia:// resolution on/off (state owned by the popup).',
    request: '{ action, enabled:boolean }',
    response: 'none (synchronous)',
  },
  [ACTIONS.updateServerConfig]: {
    summary: 'Persist the dig-node / RPC host config.',
    request: '{ action, host?:string } | { action, url?:string, port?:number }',
    response: 'none (synchronous)',
  },
  [ACTIONS.updateRpcHost]: {
    summary: 'Background → content broadcast: the RPC host changed; refresh the cached value.',
    request: '{ action, rpcHost:string }',
    response: 'none (one-way to content scripts)',
  },
  [ACTIONS.walletRpc]: {
    summary: 'Broker one window.chia CHIP-0002 RPC over WalletConnect → Sage (per-origin gated).',
    request: '{ action, method:string, params?:object, origin?:string }',
    response: '{ status:number /* 200|202|4xx|5xx */, body:{ data } | { error } }',
  },
  [ACTIONS.walletConsent]: {
    summary: 'Popup approves/revokes a dapp origin for wallet access.',
    request: '{ action, origin:string, approved:boolean }',
    response: '{ success:boolean, error?:string }',
  },
  [ACTIONS.createWallet]: {
    summary:
      'Create a new self-custody wallet: generate a 24-word recovery phrase, encrypt its entropy (DIGWX1) in the offscreen vault, persist the encrypted blob, and start the unlock TTL.',
    request: '{ action, password:string, label?:string, strong?:boolean }',
    response:
      "{ lockState:'unlocked', mnemonic:string /* shown ONCE for backup, never stored */, address?:string } | { success:false, code, message }",
  },
  [ACTIONS.importWallet]: {
    summary:
      'Import a wallet from a 24-word recovery phrase: validate the BIP-39 checksum, encrypt its entropy (DIGWX1) in the offscreen vault, persist the blob, and start the unlock TTL.',
    request: '{ action, mnemonic:string, password:string, label?:string, strong?:boolean }',
    response: "{ lockState:'unlocked' } | { success:false, code:'INVALID_MNEMONIC'|..., message }",
  },
  [ACTIONS.unlockWallet]: {
    summary:
      'Unlock the wallet: the offscreen vault runs Argon2id + AES-GCM decrypt and holds the entropy in memory; the SW sets the session unlock-expiry. Errors collapse to one opaque UNLOCK_FAILED.',
    request: '{ action, password:string }',
    response: "{ lockState:'unlocked', usedFallback?:boolean } | { success:false, code:'UNLOCK_FAILED', message }",
  },
  [ACTIONS.lockWallet]: {
    summary: 'Lock the wallet: the offscreen vault zeroizes + drops the decrypted key; the SW clears the unlock-expiry.',
    request: '{ action }',
    response: "{ lockState:'locked' }",
  },
  [ACTIONS.revealPhrase]: {
    summary:
      'Reveal the 24-word recovery phrase for backup. Re-runs the FULL password unlock (never from the TTL window); the phrase is returned for one-time display, never stored.',
    request: '{ action, password:string }',
    response: '{ mnemonic:string } | { success:false, code:\'UNLOCK_FAILED\', message }',
  },
  [ACTIONS.getLockState]: {
    summary: "Report the wallet lock state: 'none' (no wallet), 'locked' (wallet exists, key not in memory / TTL expired), or 'unlocked'.",
    request: '{ action }',
    response: "{ lockState:'none'|'locked'|'unlocked', activeWalletId?:string, unlockExpiry?:number }",
  },
  [ACTIONS.getReceiveAddress]: {
    summary: 'Derive the wallet\'s pooled receive address (index 0, unhardened) in the offscreen vault. Requires an unlocked wallet.',
    request: '{ action }',
    response: "{ address:string } | { success:false, code:'LOCKED'|..., message }",
  },
  [ACTIONS.getCustodyBalances]: {
    summary: 'Scan pooled self-custody balances (both HD schemes) from coinset for XCH + watched CATs. Cached to walletCache.balances; returns the cached snapshot on a transient scan failure.',
    request: '{ action }',
    response: "{ balances:{ xch:number, cats:{ [assetId]:number } }, cached?:boolean } | { success:false, code, message }",
  },
  [ACTIONS.reportVerification]: {
    summary: 'Viewer reports the Merkle-verification result for rendered chia:// content.',
    request: '{ action, verified:boolean, urn:string }',
    response: 'none (synchronous)',
  },
  [ACTIONS.getVerification]: {
    summary: "Popup asks for the active tab's verification state.",
    request: '{ action }',
    response: "{ verification: { state:'verified'|'failed', urn:string } | null }",
  },
  [ACTIONS.getDigNodeStatus]: {
    summary: 'Probe whether a local dig-node is reachable; report the chosen base.',
    request: '{ action }',
    response: '{ reachable:boolean, base:string|null }',
  },
  [ACTIONS.recordLedgerEntry]: {
    summary: "Viewer records one resource's inclusion-proof verdict into the active tab's proof ledger (DIG Shields #134).",
    request: '{ action, storeId:string, rootHash:string, resourcePath:string, inclusionProofPassed:boolean, errorCode?:string, executionProofStatus?:string }',
    response: '{ success:boolean }',
  },
  [ACTIONS.getShieldLedger]: {
    summary: "DIG Shields: the active tab's capsule + grouped per-resource proof ledger (verified/failed) + aggregate verdict.",
    request: '{ action }',
    response: "{ capsule:{storeId,rootHash}|null, verification:{state}|null, group:{passed,failed,passedCount,failedCount,total,allPassed,empty}, entries:object[] }",
  },
  [ACTIONS.getControlStatus]: {
    summary: 'DIG Control Panel: detect a local dig-node (manage vs install) + best-effort control.status; honest hosted-RPC fallback. Mirrors dig://control.',
    request: '{ action }',
    response: "{ mode:'manage'|'install', localNode:boolean, base:string|null, controlEndpoint:string|null, readFallback:string, status:object|null, authRequired:boolean, controlMethods:string[] }",
  },
  [ACTIONS.reportError]: {
    summary: 'Record a resolution-strategy error (kept as a rolling diagnostics buffer).',
    request: '{ action, url:string, error:string, strategy:string, timestamp:number }',
    response: 'none (synchronous)',
  },
  [ACTIONS.reportSuccess]: {
    summary: 'Record a resolution-strategy success (rolling diagnostics buffer).',
    request: '{ action, url:string, strategy:string, timestamp:number }',
    response: 'none (synchronous)',
  },
  [ACTIONS.addSearchEngine]: {
    summary: 'Register the DIG omnibox/search engine.',
    request: '{ action }',
    response: '{ success:boolean, ... }',
  },
  [ACTIONS.getDefaultSearchEngine]: {
    summary: 'Read the current default search engine.',
    request: '{ action }',
    response: '{ ... }',
  },
  [ACTIONS.isDigSearchDefault]: {
    summary: 'Report whether DIG is the default search engine.',
    request: '{ action }',
    response: '{ ... }',
  },
  [ACTIONS.updateSearchConfig]: {
    summary: 'Persist + re-apply the custom search-engine config.',
    request: '{ action, name?:string, keyword?:string, url?:string, enabled?:boolean }',
    response: '{ success:boolean, ... }',
  },
  [ACTIONS.getCapabilities]: {
    summary: 'Self-describe: protocol version, the action list, the wallet method surface, and error codes.',
    request: '{ action }',
    response:
      '{ version, messageProtocol, actions:string[], walletMethods:string[], stateChangingMethods:string[], errorCodes:string[], bridge:object }',
  },
});

/** True if `action` is a catalogued, known message action. */
export function isKnownAction(action) {
  return typeof action === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, action);
}

/**
 * Build the `getCapabilities` response payload — the machine-readable self-description of
 * this extension's message + wallet + error surface. `version` is the extension version
 * (caller passes it, since this module can't read the manifest).
 *
 * @param {string} [extensionVersion]
 * @returns {{
 *   version: string, messageProtocol: number, actions: string[],
 *   walletMethods: string[], stateChangingMethods: string[],
 *   errorCodes: string[], bridge: Record<string,string>
 * }}
 */
export function buildCapabilities(extensionVersion) {
  return {
    version: extensionVersion || 'unknown',
    messageProtocol: MESSAGE_PROTOCOL_VERSION,
    actions: Object.values(ACTIONS),
    walletMethods: [...WALLET_METHODS],
    stateChangingMethods: [...STATE_CHANGING_METHODS],
    errorCodes: Object.values(DIG_ERR),
    bridge: { ...BRIDGE },
  };
}
