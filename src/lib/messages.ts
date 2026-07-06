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
 * Plain ES module (no chrome.* / DOM) so background.js, dig-viewer.js, options.js, the React
 * shell (via the #shared/* alias) AND tests under `node --test` can all import it.
 */

import { WALLET_METHODS, STATE_CHANGING_METHODS } from './wallet-methods';
import { DIG_ERR } from './error-codes';

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
 *
 * v5 (#56 send): added `prepareSend` (build + decode summary), `confirmSend` (sign + broadcast, the
 * approved step), and `sendStatus` (poll confirmation) — routed to the offscreen vault.
 *
 * v6 (#56 activity): added `getActivity` — the SW routes it to the offscreen vault, which
 * reconstructs the transaction ledger from coinset (coin-diff → decode → classify → net).
 *
 * v7 (#56 trade): added `makeOffer` (build a shareable `offer1…`), `inspectOffer` (decode a
 * two-sided summary), `prepareTrade` (build + sign a take/cancel, held for approval), and
 * `confirmTrade` (broadcast the approved trade) — routed to the offscreen vault.
 *
 * v8 (#56 NFTs/Collectibles): added `listNfts` (discover the wallet's NFTs by hint, both HD schemes),
 * `prepareNftTransfer` (build + hold an NFT transfer for approval), and `confirmNftTransfer`
 * (sign + broadcast the approved transfer — reuses the vault's `confirmSend` broadcast path) —
 * routed to the offscreen vault; poll confirmation via the shared `sendStatus`.
 *
 * v9 (#56 dApp approval, §5.5): `walletRpc` now routes to the SELF-CUSTODY wallet when one exists
 * (falling back to the Sage broker otherwise) — connect + reads go straight to the offscreen vault;
 * sign/message requests summon a dedicated approval window. Added `dappApprovalList` (the window
 * reads the pending-request queue + decoded, tamper-resistant summaries) and `dappApprovalResolve`
 * (the window returns the user's approve/reject decision; approve signs in the vault).
 *
 * v10 (#66 in-window app-view): added `appViewFraming` — the React shell asks the SW to install/
 * remove an EPHEMERAL declarativeNetRequest session rule that strips `*.on.dig.net`'s framing
 * headers (X-Frame-Options / CSP frame-ancestors) for the app-view iframe, so a DIG dApp renders
 * in-window instead of being forced into a tab. Scoped to on.dig.net sub-frames (and the app-view's
 * tab when in the expanded layout) and removed the moment the app-view closes.
 *
 * v11 (#67 P0-4 connected sites): `walletRpc` now also handles the EIP-2255-shaped permission methods
 * `wallet_getPermissions` / `wallet_revokePermissions` against the shared per-origin consent store.
 * Added `listConnectedSites` (the Connected-sites settings screen reads every origin's capability),
 * `revokeConnectedSite` (per-site revoke), and `revokeAllConnectedSites` (revoke all).
 *
 * v12 (#118 remove WalletConnect): `walletRpc` no longer falls back to a WalletConnect → Sage broker.
 * The extension is a self-custody wallet, so EVERY window.chia request routes to the offscreen vault
 * via the self-custody dApp router (connect + reads served directly; sign/message summon the approval
 * window). A request with no/locked wallet resolves to 202 (pending) or a locked-class error rather
 * than pairing an external wallet. No action names changed; the routing/fallback behaviour did.
 *
 * v13 (#119 full window.chia method surface): `walletRpc` now routes the asset-generic READS
 * (getAssetBalance / getAssetCoins / filterUnlockedCoins / getNFTs) and the value-moving WRITES
 * (chia_send/transfer, sendTransaction, createOffer, takeOffer, cancelOffer) to the vault instead of
 * the 4004 stub. Writes join sign/message on the approval-window queue (built in the vault, summary
 * decoded from the built artifact, broadcast/released only on approve); a user reject now surfaces as
 * CHIP-0002 4002 USER_REJECTED (was 4001). No action names changed; the served method set grew.
 */
export const MESSAGE_PROTOCOL_VERSION = 13;

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
  // ── wallet (window.chia self-custody) ──
  walletRpc: 'walletRpc',
  walletConsent: 'walletConsent',
  // ── self-custody dApp approval window (#56 §5.5): the window ↔ SW channel ──
  dappApprovalList: 'dappApprovalList',
  dappApprovalResolve: 'dappApprovalResolve',
  // ── connected sites / granular permissions (#67 P0-4): the Settings screen ↔ SW channel ──
  listConnectedSites: 'listConnectedSites',
  revokeConnectedSite: 'revokeConnectedSite',
  revokeAllConnectedSites: 'revokeAllConnectedSites',
  // ── self-custody wallet (#56): keystore ops the SW routes to the offscreen vault ──
  createWallet: 'createWallet',
  importWallet: 'importWallet',
  unlockWallet: 'unlockWallet',
  lockWallet: 'lockWallet',
  revealPhrase: 'revealPhrase',
  getLockState: 'getLockState',
  getReceiveAddress: 'getReceiveAddress',
  getCustodyBalances: 'getCustodyBalances',
  prepareSend: 'prepareSend',
  confirmSend: 'confirmSend',
  sendStatus: 'sendStatus',
  getActivity: 'getActivity',
  makeOffer: 'makeOffer',
  inspectOffer: 'inspectOffer',
  prepareTrade: 'prepareTrade',
  confirmTrade: 'confirmTrade',
  // ── self-custody NFTs / Collectibles (#56): routed to the offscreen vault ──
  listNfts: 'listNfts',
  prepareNftTransfer: 'prepareNftTransfer',
  confirmNftTransfer: 'confirmNftTransfer',
  // ── in-window app-view (#66): install/remove the on.dig.net framing bypass DNR rule ──
  appViewFraming: 'appViewFraming',
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
    summary:
      'Route one window.chia CHIP-0002 RPC. The EIP-2255-shaped permission methods (wallet_getPermissions / wallet_revokePermissions, #67 P0-4) are answered from the shared per-origin consent store. Every other request routes to the self-custody wallet (§5.5): connect + reads (getAddress/getPublicKeys/getAssetBalance/getAssetCoins/filterUnlockedCoins/getNFTs) go to the offscreen vault, and the sign/message + value-moving writes (transfer/sendTransaction/createOffer/takeOffer/cancelOffer) summon the approval window (per-origin gated; built in the vault, broadcast/released only on approve). A user reject → 4002; an unimplemented method → 4004. There is no WalletConnect/Sage fallback.',
    request: '{ action, method:string, params?:object, origin?:string }',
    response: '{ status:number /* 200|202|4xx|5xx */, body:{ data } | { error } }',
  },
  [ACTIONS.walletConsent]: {
    summary: 'Popup approves/revokes a dapp origin for wallet access.',
    request: '{ action, origin:string, approved:boolean }',
    response: '{ success:boolean, error?:string }',
  },
  [ACTIONS.dappApprovalList]: {
    summary:
      'Approval window (§5.5): read the pending dApp approval-request queue, each enriched with the tamper-resistant summary decoded FROM THE BUILT SPEND/OFFER (or flagged needsUnlock when the wallet is locked). Kinds: the sign/message pair plus the value-moving writes (send/sendTransaction/createOffer/takeOffer/cancelOffer).',
    request: '{ action }',
    response:
      "{ requests:[{ id, origin, method, kind:'signCoinSpends'|'signMessage'|'send'|'sendTransaction'|'createOffer'|'takeOffer'|'cancelOffer', summary:object|null, needsUnlock:boolean, decodeError:boolean, createdAt:number }], lockState:'none'|'locked'|'unlocked', summoned:boolean }",
  },
  [ACTIONS.dappApprovalResolve]: {
    summary:
      "Approval window (§5.5): return the user's decision for one queued request. Approve → the offscreen vault performs the built action (sign / broadcast the prepared send or trade / release the built offer) and the dApp promise resolves; reject → the dApp gets a 4002 user-rejection error and nothing is broadcast.",
    request: '{ action, id:string, approved:boolean }',
    response: '{ success:boolean, remaining:number, code?:string }',
  },
  [ACTIONS.listConnectedSites]: {
    summary:
      'Connected sites (#67 P0-4): list every origin the wallet is connected to, each as a capability record (connected addresses, granted/last-used timestamps, allowed methods) for the Settings/Advanced screen.',
    request: '{ action }',
    response:
      '{ sites:[{ origin, approved:true, addresses:string[], methods:string[], grantedAt:number, lastUsed:number|null }] } | { success:false, code, message }',
  },
  [ACTIONS.revokeConnectedSite]: {
    summary: 'Connected sites (#67 P0-4): revoke ONE origin — clears its consent so it must re-request access.',
    request: '{ action, origin:string }',
    response: '{ success:true } | { success:false, code, message }',
  },
  [ACTIONS.revokeAllConnectedSites]: {
    summary: 'Connected sites (#67 P0-4): revoke EVERY connected origin at once.',
    request: '{ action }',
    response: '{ success:true } | { success:false, code, message }',
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
  [ACTIONS.prepareSend]: {
    summary: 'Build (not sign/broadcast) an XCH or CAT send in the offscreen vault; hold it under a pending id and return the decoded (tamper-resistant) summary to approve. A CAT send carries the token TAIL as assetId (omitted / "xch" = native XCH); the vault routes on assetId (#121).',
    request: '{ action, recipient:string /* xch1… */, amount:string /* base units */, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */ }',
    response: "{ pendingId:string, summary:{ asset:'XCH'|<assetId>, sent, change, fee, recipientPuzzleHashHex, coinCount } } | { success:false, code, message }",
  },
  [ACTIONS.confirmSend]: {
    summary: 'Sign + BROADCAST a previously-prepared send (the approved step — the only place a real spend is pushed). Returns an input coin id to poll.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.sendStatus]: {
    summary: 'Poll whether a broadcast send has confirmed (an input coin is now recorded spent).',
    request: '{ action, coinId:string }',
    response: '{ confirmed:boolean } | { success:false, code, message }',
  },
  [ACTIONS.getActivity]: {
    summary: 'Reconstruct the transaction ledger (read-only) from coinset in the offscreen vault: coin-diff (both HD schemes, incl. spent) → decode → classify (XCH/CAT/trade) → net + counterparty. Cached to walletCache.activity; incremental from a height cursor.',
    request: '{ action }',
    response: "{ events:[{ id, kind:'sent'|'received'|'trade', asset, amount, counterparty, height, timestamp, coinId }], cursorHeight:number } | { success:false, code, message }",
  },
  [ACTIONS.makeOffer]: {
    summary: 'Build (not broadcast) a shareable trade offer in the offscreen vault: spend the offered asset into the settlement puzzle + assert the requested payment; returns the `offer1…` string + two-sided summary.',
    request: "{ action, offered:{ asset:{kind:'xch'}|{kind:'cat',assetId}, amount:string }, requested:{ asset, amount:string }, fee?:string }",
    response: "{ offer:string /* offer1… */, offerSummary:{ offered:[{asset,amount}], requested:[{asset,amount,toPuzzleHashHex}] } } | { success:false, code, message }",
  },
  [ACTIONS.inspectOffer]: {
    summary: 'Decode an `offer1…` string to its two-sided (offered vs requested) summary in the offscreen vault. Read-only; no broadcast.',
    request: '{ action, offerStr:string }',
    response: '{ offerSummary:{ offered:[{asset,amount}], requested:[{asset,amount,toPuzzleHashHex}] } } | { success:false, code, message }',
  },
  [ACTIONS.prepareTrade]: {
    summary: 'Build + sign (not broadcast) a TAKE (fund + accept) or CANCEL (reclaim) of an offer; hold it under a pending id and return the two-sided summary to approve.',
    request: "{ action, offerStr:string, tradeKind:'take'|'cancel', fee?:string }",
    response: '{ pendingId:string, offerSummary:{ offered, requested } } | { success:false, code, message }',
  },
  [ACTIONS.confirmTrade]: {
    summary: 'BROADCAST a previously-prepared trade (the approved step — the only place a trade is pushed). Returns an input coin id to poll.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.listNfts]: {
    summary: "List the wallet's NFTs (Collectibles) — the offscreen vault derives both HD schemes, finds coins hinted to its inner puzzle hashes (coinset get_coin_records_by_hints), and reconstructs each NFT from its parent spend. Read-only.",
    request: '{ action }',
    response: "{ nfts:[{ launcherId, coinId, p2PuzzleHash, collectionId, editionNumber, editionTotal, royaltyBasisPoints, royaltyPuzzleHash, dataUris, dataHash, metadataUris, metadataHash, licenseUris }] } | { success:false, code, message }",
  },
  [ACTIONS.prepareNftTransfer]: {
    summary: "Build (not sign/broadcast) a transfer of the wallet's NFT to another address in the offscreen vault; hold it under a pending id and return the decoded summary to approve. The recipient's p2 puzzle hash is carried as the create-coin hint.",
    request: '{ action, launcherId:string /* hex */, recipient:string /* xch1… */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, nftSummary:{ launcherId, recipientPuzzleHashHex, fee, coinCount } } | { success:false, code:\'NFT_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmNftTransfer]: {
    summary: 'Sign + BROADCAST a previously-prepared NFT transfer (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.appViewFraming]: {
    summary: "In-window app-view (#66): install (enable:true) or remove (enable:false) an ephemeral declarativeNetRequest session rule that strips *.on.dig.net's X-Frame-Options + CSP framing headers for the app-view iframe, so a DIG dApp renders in-window instead of a forced tab. Scoped to on.dig.net sub-frames (and the sender's tab in the expanded layout); removed when the app-view closes.",
    request: '{ action, enable:boolean }',
    response: '{ success:boolean }',
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
export function isKnownAction(action: unknown): boolean {
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
export function buildCapabilities(extensionVersion?: string): {
  version: string;
  messageProtocol: number;
  actions: string[];
  walletMethods: string[];
  stateChangingMethods: string[];
  errorCodes: string[];
  bridge: Record<string, string>;
} {
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
