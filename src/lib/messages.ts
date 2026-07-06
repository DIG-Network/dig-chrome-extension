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
 *
 * v14 (#91 coin control): added `listCoins` (per-asset unspent coins — id / amount / confirmed
 * height), `prepareSplit` (one/more coins → N distinct self coins), and `prepareCombine` (N coins →
 * one self coin) — all routed to the offscreen vault, built on the same `Spends`/`Action` driver as
 * Send and broadcast via the shared `confirmSend`. `prepareSend` also gained an optional `coinIds`
 * to hand-pick which coins fund a send (overriding auto-selection). No spend type / wasm added.
 *
 * v15 (#90 multi-wallet switcher): added `listWallets` (record-free registry metadata + the active
 * id), `switchWallet` (activate another wallet — instant when its key is cached this session, else
 * unlock-then-activate, else NEEDS_UNLOCK), `renameWallet`, and `removeWallet` (never the last;
 * re-homes the active wallet). The SW keeps a per-wallet DIGWX1 record registry over the existing
 * keystore (no new crypto/wasm); the offscreen vault caches several unlocked keys and switches which
 * is active. `getLockState`/create/import already carry `activeWalletId`.
 *
 * v16 (#92 NFT minting): added `prepareNftMint` (build + hold a new-NFT mint — CHIP-0007 metadata +
 * royalty — for approval) and `confirmNftMint` (sign + broadcast the approved mint — reuses the vault
 * `confirmSend` broadcast path) — routed to the offscreen vault; poll confirmation via the shared
 * `sendStatus`. New-NFT construction uses the shipped chia-wallet-sdk-wasm NFT launcher; no new wire
 * contract. Bulk/edition minting is a follow-up (#99). DID-owner assignment is a follow-up (#93).
 *
 * v17 (#93 DID management — create/list/transfer/profile/NFT-owner-assign): added `listDids`
 * (discover the wallet's DIDs by hint, both HD schemes), `prepareDidCreate` (build + hold a new
 * "simple" DID create for approval) + `confirmDidCreate`, `prepareDidTransfer` (build + hold a DID
 * ownership transfer to another wallet) + `confirmDidTransfer`, `prepareDidProfileUpdate` (build +
 * hold an on-chain profile-name / metadata change) + `confirmDidProfileUpdate`, and
 * `prepareNftDidAssign` (build + hold assigning an owned DID as an owned NFT's `currentOwner` — the
 * CHIP-0011 ownership-layer bonding handshake) + `confirmNftDidAssign` — every confirm reuses the
 * vault's `confirmSend` broadcast path; poll confirmation via the shared `sendStatus`. DID
 * create/transfer/profile-update are built from the shipped chia-wallet-sdk-wasm
 * `Clvm.createEveDid`/`spendDid` primitives (no `Action`/`Spends` driver support exists for DIDs);
 * NFT↔DID assignment is built from `Clvm.spendNft`/`spendDid` + the `TransferNft` condition (no
 * `Spends.addDid` exists either — verified against the xch-dev/chia-wallet-sdk driver source). A
 * profile (metadata) update needs an internal two-spend "settle" hop so a chain rescan can observe
 * it (DID metadata is curried into the puzzle, unlike ownership/`p2PuzzleHash`, which ride the
 * create-coin hint) — see `dids.ts`'s `prepareDidProfileUpdate` doc. No new wire contract. DID
 * management is ADVANCED functionality: the wallet UI surfaces it in the fullscreen layout only
 * (§145 tiering) — this message-protocol addition itself is surface-agnostic. Assigning a DID as an
 * NFT's owner AT MINT TIME (vs. on an already-minted NFT, which this version covers) remains a
 * follow-up seam with #92.
 */
export const MESSAGE_PROTOCOL_VERSION = 17;

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
  // ── multi-wallet switcher (#90): registry over the per-wallet DIGWX1 records ──
  listWallets: 'listWallets',
  switchWallet: 'switchWallet',
  renameWallet: 'renameWallet',
  removeWallet: 'removeWallet',
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
  // ── NFT minting (#92): build a new NFT + broadcast (confirm reuses the confirmSend path) ──
  prepareNftMint: 'prepareNftMint',
  confirmNftMint: 'confirmNftMint',
  // ── DID management (#93): create/list/transfer/profile a self-custody identity (confirm reuses confirmSend) ──
  listDids: 'listDids',
  prepareDidCreate: 'prepareDidCreate',
  confirmDidCreate: 'confirmDidCreate',
  prepareDidTransfer: 'prepareDidTransfer',
  confirmDidTransfer: 'confirmDidTransfer',
  prepareDidProfileUpdate: 'prepareDidProfileUpdate',
  confirmDidProfileUpdate: 'confirmDidProfileUpdate',
  // ── assign a wallet-owned DID as an NFT's owner (#93; confirm reuses confirmSend) ──
  prepareNftDidAssign: 'prepareNftDidAssign',
  confirmNftDidAssign: 'confirmNftDidAssign',
  // ── coin control (#91): per-asset coin listing + split / combine (confirmed via confirmSend) ──
  listCoins: 'listCoins',
  prepareSplit: 'prepareSplit',
  prepareCombine: 'prepareCombine',
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
  [ACTIONS.listWallets]: {
    summary:
      'Multi-wallet (#90): list the wallet registry as record-FREE metadata (id, label, createdAt, active) + the active id. The encrypted DIGWX1 records never leave the SW.',
    request: '{ action }',
    response: '{ wallets:[{ id, label, createdAt, active:boolean }], activeWalletId:string|null } | { success:false, code, message }',
  },
  [ACTIONS.switchWallet]: {
    summary:
      "Multi-wallet (#90): make another wallet active. Instant when its key is cached in the vault this session; with a password it unlocks-then-activates; without one for a not-yet-unlocked wallet it returns NEEDS_UNLOCK so the UI prompts. The active wallet drives balances/receive/send/activity.",
    request: '{ action, walletId:string, password?:string }',
    response: "{ lockState:'unlocked', activeWalletId:string } | { success:false, code:'NEEDS_UNLOCK'|'NO_WALLET'|'UNLOCK_FAILED', message }",
  },
  [ACTIONS.renameWallet]: {
    summary: 'Multi-wallet (#90): rename one wallet (metadata only — no key, no password). Returns the updated registry metadata + active id.',
    request: '{ action, walletId:string, label:string }',
    response: '{ success:true, wallets:[{ id, label, createdAt, active }], activeWalletId:string|null } | { success:false, code:\'NO_WALLET\'|\'BAD_REQUEST\', message }',
  },
  [ACTIONS.removeWallet]: {
    summary:
      'Multi-wallet (#90): remove one wallet (zeroizes its cached key). Refuses the last wallet (LAST_WALLET). Removing the active wallet re-homes active to another; the session stays unlocked only if the new active wallet\'s key is still cached, else it locks.',
    request: '{ action, walletId:string }',
    response: "{ success:true, wallets:[{ id, label, createdAt, active }], activeWalletId:string|null, lockState:'locked'|'unlocked' } | { success:false, code:'LAST_WALLET'|'NO_WALLET', message }",
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
    summary: 'Build (not sign/broadcast) an XCH or CAT send in the offscreen vault; hold it under a pending id and return the decoded (tamper-resistant) summary to approve. A CAT send carries the token TAIL as assetId (omitted / "xch" = native XCH); the vault routes on assetId (#121). An optional coinIds hand-picks which coins fund the send, overriding auto-selection (#91).',
    request: '{ action, recipient:string /* xch1… */, amount:string /* base units */, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */, coinIds?:string[] /* hex; hand-picked funding coins */ }',
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
  [ACTIONS.prepareNftMint]: {
    summary: "Build (not sign/broadcast) a MINT of one new NFT owned by the wallet (#92) — CHIP-0007 metadata (data/metadata/license URIs + optional hashes), an edition, and a royalty percentage paid to the minter (or a chosen royalty address). The singleton + change are funded from the wallet's XCH coins. Held under a pending id; returns the decoded (tamper-resistant) summary + the new launcher id to approve. Broadcast via confirmNftMint. Bulk/edition minting is a follow-up (#99); DID-owner assignment is a follow-up (#93).",
    request: '{ action, nftMint:{ dataUris:string[] /* ≥1 */, dataHash?:string /* hex */, metadataUris?:string[], metadataHash?:string, licenseUris?:string[], licenseHash?:string, editionNumber?:string, editionTotal?:string, royaltyBasisPoints?:number, royaltyAddress?:string /* xch1… */, fee?:string /* mojos */ } }',
    response: '{ pendingId:string, launcherId:string, nftMintSummary:{ launcherId, dataUris, metadataUris, licenseUris, editionNumber, editionTotal, royaltyBasisPoints, royaltyPuzzleHashHex, fee, coinCount } } | { success:false, code:\'BAD_REQUEST\'|\'NO_XCH_COINS\'|..., message }',
  },
  [ACTIONS.confirmNftMint]: {
    summary: 'Sign + BROADCAST a previously-prepared NFT mint (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.listDids]: {
    summary: "List the wallet's DIDs (#93) — the offscreen vault derives both HD schemes, finds coins hinted to its inner puzzle hashes (coinset get_coin_records_by_hints), and reconstructs each DID from its parent spend. Read-only.",
    request: '{ action }',
    response: "{ dids:[{ launcherId, coinId, p2PuzzleHash, recoveryListHash, numVerificationsRequired }] } | { success:false, code, message }",
  },
  [ACTIONS.prepareDidCreate]: {
    summary: "Build (not sign/broadcast) the CREATION of one new \"simple\" DID (no recovery list, 1 verification) owned by the wallet (#93), funded from a single wallet-owned XCH coin. Held under a pending id; returns the decoded (tamper-resistant) summary + the new launcher id to approve. Broadcast via confirmDidCreate.",
    request: '{ action, fee?:string /* mojos */ }',
    response: '{ pendingId:string, launcherId:string, didCreateSummary:{ launcherId, p2PuzzleHashHex, fee, coinCount } } | { success:false, code:\'NO_XCH_COINS\'|\'NO_SUITABLE_COIN\'|..., message }',
  },
  [ACTIONS.confirmDidCreate]: {
    summary: 'Sign + BROADCAST a previously-prepared DID create (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareDidTransfer]: {
    summary: "Build (not sign/broadcast) a transfer of the wallet's DID to another address in the offscreen vault (#93); hold it under a pending id and return the decoded summary to approve. The recipient's p2 puzzle hash is carried as the create-coin hint. A fee, when given, is paid from a separate wallet-owned XCH coin.",
    request: '{ action, launcherId:string /* hex */, recipient:string /* xch1… */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, didSummary:{ launcherId, recipientPuzzleHashHex, fee, coinCount } } | { success:false, code:\'DID_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmDidTransfer]: {
    summary: 'Sign + BROADCAST a previously-prepared DID transfer (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareDidProfileUpdate]: {
    summary: "Build (not sign/broadcast) a PROFILE update of the wallet's DID (#93) — sets its on-chain metadata to a plain UTF-8 profileName, keeping the same owner/launcher id. Internally TWO chained DID spends (an ephemeral self-to-self hop) so the change is observable on a later rescan (metadata is curried into the puzzle, not carried by the create-coin hint). A fee, when given, is paid from a separate wallet-owned XCH coin.",
    request: '{ action, launcherId:string /* hex */, profileName:string, fee?:string /* mojos */ }',
    response: '{ pendingId:string, didProfileSummary:{ launcherId, profileName, fee, coinCount } } | { success:false, code:\'DID_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmDidProfileUpdate]: {
    summary: 'Sign + BROADCAST a previously-prepared DID profile update (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareNftDidAssign]: {
    summary: "Build (not sign/broadcast) assigning the wallet's DID as the OWNER of the wallet's NFT (#93) — the CHIP-0011 ownership-layer bonding handshake (a TransferNft condition on the NFT + a matching puzzle-announcement exchange with the DID), both spent in ONE bundle. Neither the NFT's nor the DID's custody changes. A fee, when given, is paid from a separate wallet-owned XCH coin.",
    request: '{ action, launcherId:string /* the NFT, hex */, didLauncherId:string /* hex */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, nftDidAssignSummary:{ nftLauncherId, didLauncherId, fee, coinCount } } | { success:false, code:\'NFT_NOT_FOUND\'|\'DID_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmNftDidAssign]: {
    summary: 'Sign + BROADCAST a previously-prepared NFT↔DID assignment (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.listCoins]: {
    summary: "List the wallet's UNSPENT coins for one asset (coin control #91) — native XCH at the derived inner puzzle hashes, or a CAT at its CAT puzzle hash, both HD schemes. Each coin carries id + amount + confirmed height. Read-only; routed purely by assetId (#121).",
    request: '{ action, assetId?:string /* CAT TAIL hex; omit for native XCH */ }',
    response: '{ coins:[{ coinId:string, amount:string, confirmedHeight:number }] } | { success:false, code, message }',
  },
  [ACTIONS.prepareSplit]: {
    summary: 'Build (not sign/broadcast) a SPLIT of one/more of the wallet coins into N distinct self coins (coin control #91); hold it under a pending id and return the decoded (tamper-resistant, self-send-verified) summary to approve. Broadcast via confirmSend. Routed on assetId (#121).',
    request: '{ action, coinIds:string[] /* hex */, outputs:number /* ≥2 */, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */ }',
    response: "{ pendingId:string, coinOpSummary:{ asset, kind:'split', inputCoinCount, outputCoinCount, total, fee } } | { success:false, code, message }",
  },
  [ACTIONS.prepareCombine]: {
    summary: 'Build (not sign/broadcast) a COMBINE of two or more of the wallet coins into a SINGLE self coin (coin control #91); hold it under a pending id and return the decoded summary to approve. Broadcast via confirmSend. Routed on assetId (#121).',
    request: '{ action, coinIds:string[] /* hex, ≥2 */, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */ }',
    response: "{ pendingId:string, coinOpSummary:{ asset, kind:'combine', inputCoinCount, outputCoinCount, total, fee } } | { success:false, code, message }",
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
