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
 *
 * v18 (#94 NFT offers + CHIP-0011 royalty): the `makeOffer`/`inspectOffer`/`prepareTrade` wire shape
 * (`WireOfferAsset`) gained an `{ kind: 'nft', launcherId }` variant (OFFERED side only) alongside
 * the existing `xch`/`cat` kinds — no new action names, only a shape extension, hence the version
 * bump per this file's own contract. Offering an NFT with a nonzero on-chain royalty automatically
 * funds the CHIP-0011 royalty payment on take (proven against the wasm Simulator: omitting it is
 * REJECTED by chain validation, not merely by this wallet's own bookkeeping). Also fixed a surface-
 * tiering gap (§145): Trade (make/take an offer) is ADVANCED functionality and now renders a
 * view-only "open full screen" affordance on the popup, same as Collectibles/Identity — it
 * previously rendered the full make/take forms in the popup too. `DID` is deliberately NOT an offer
 * asset (verified against both the reference `chia-wallet-sdk` driver and Sage: neither models a
 * `dids` offer leg — see `offers.ts`'s module doc). Requesting a SPECIFIC NFT (buying) is a tracked
 * follow-up (needs a "read any NFT by launcher id" chain capability this wallet doesn't have yet).
 *
 * v19 (#165 single active derivation index model): the browser wallet operates on ONE HD derivation
 * index at a time (default 0) instead of a multi-index gap-limit sweep — full multi-index HD scanning
 * (both schemes across a gap limit) is too intensive for a browser wallet and was the root of the
 * wallet's load/timeout problems (#148/#154). Added `setActiveIndex` (navigate the active wallet's
 * active index — prev/next/jump; a pure SW registry op, persisted per wallet, like `renameWallet`).
 * Every derivation-touching request/response gained an `activeIndex?: number` field (replacing the
 * retired `gapLimit`): `getReceiveAddress`, `getCustodyBalances` (via `scanBalances`), `getActivity`,
 * `listNfts`, `listDids`, `listCoins`, `prepareSend`, `prepareSplit`, `prepareCombine`,
 * `prepareNftTransfer`, `prepareNftMint`, `prepareDidCreate`, `prepareDidTransfer`,
 * `prepareDidProfileUpdate`, `prepareNftDidAssign`, `makeOffer`, `prepareTrade` — each now derives
 * ONLY the active index's puzzle hashes (both HD schemes — a tiny fixed set, one cheap coinset query),
 * never a gap-limit range. `getLockState`'s response also gained `activeIndex` (the active wallet's
 * current index) so the navigator UI hydrates from the same poll that already drives lock state.
 * #160 (configurable scan-index count) is SUPERSEDED — there is no multi-index scan left to size.
 *
 * `20` (#154) replaced `getActivity`'s on-chain reconstruction with the LOCAL activity log: its
 * response dropped `cursorHeight` and each event's `height` field (BREAKING) in favor of a per-entry
 * `status:'pending'|'confirmed'`, and its request no longer takes `watchedCats`/`sinceHeight` (a
 * synchronous storage read needs neither). `confirmSend`/`confirmTrade` additively gained an optional
 * `activityHint: { asset, amount, counterparty }` captured at prepare time.
 *
 * v21 (#175 dig-dns Path-B proxy fallback): added `getDigDnsStatus` — reports the ONE shared
 * dig-dns availability signal (`unknown`/`direct`/`proxy`/`unavailable`, the bound gateway port,
 * the PAC URL, and whether the PAC proxy is currently engaged). The SW probes dig-dns's loopback
 * control endpoints (`/.dig/resolve-probe`, `/.dig/health`) on startup + a `chrome.alarms`
 * interval, and engages `chrome.proxy` pointed at dig-dns's `/.dig/proxy.pac` the moment a real
 * `.dig` navigation fails — self-healing `.dig` resolution when OS split-DNS (Path A) is defeated.
 * This is the SAME signal #172's open-by-URN dig-dns-detect branch reads — no per-feature probing.
 *
 * v23 (#171 Collectibles bulk transfer/burn): added `prepareNftBulkTransfer` (build a transfer of
 * MULTIPLE selected NFTs to one recipient in a SINGLE spend bundle) and `prepareNftBulkBurn` (build
 * a transfer of multiple selected NFTs to the well-known provably-unspendable puzzle hash — the
 * standard Chia-ecosystem burn mechanism). Both are held under a pending id and broadcast via the
 * shared `confirmNftBulkTransfer`/`confirmNftBulkBurn` (which reuse the vault's `confirmSend`
 * broadcast path exactly like the existing single-NFT `confirmNftTransfer`); confirmation polls via
 * the shared `sendStatus`. A burn is irreversible once confirmed — the caller MUST gate it behind an
 * explicit, distinct user confirmation and must NEVER auto-invoke the confirm step.
 *
 * v24 (#98 NFT collection metadata + richer gallery): added `getNftMetadata` -- fetches + parses the
 * off-chain CHIP-0007 JSON document a `metadataUri` points at (real name/description/attributes +
 * the collection's real name), used to enrich the Collectibles gallery + detail view beyond the
 * on-chain-only shortened-launcher-id label. Handled DIRECTLY in the background service worker
 * (`src/background/index.ts`), NOT the offscreen vault -- a simple no-vault-dependency read, like
 * the other non-custody SW actions. `metadataUris` are arbitrary third-party hosts the extension
 * cannot enumerate in advance, so `manifest.json`'s CSP `connect-src`/`host_permissions` are widened
 * to `https:`/an all-hosts pattern -- matching the breadth `img-src` already grants NFT art -- after
 * an empirically-discovered gotcha (`DEVELOPMENT_LOG.md`) showed a background service worker's own
 * `fetch()` IS still subject to `connect-src` in this Chromium build. Read-only, capped (size +
 * timeout); the caller's own cache (keyed by URI) is what avoids re-fetching, not this handler.
 *
 * v25 (#99 Collectibles bulk assign-DID): added `prepareNftBulkDidAssign` (assign the wallet's DID
 * as the owner of MULTIPLE selected NFTs in ONE spend bundle — generalizing the single-NFT
 * `prepareNftDidAssign`) + `confirmNftBulkDidAssign` (reuses the shared `confirmSend` broadcast
 * path). Purely additive — no existing action/shape changed.
 *
 * v26 (#105/#106/#107 send/receive trio): `prepareSend` gained an optional `memo` — a plain-text
 * note attached to the recipient's CREATE_COIN (PUBLIC on chain), decoded back from the built spend
 * into `summary.memoText`; mutually exclusive with `clawbackSeconds` and capped at 512 UTF-8 bytes
 * (both BAD_REQUEST). Added `listDerivedAddresses` — derive a page of the active wallet's addresses
 * (both HD schemes, indexes `0..count-1`) for VIEWING/COPYING only, never a balance scan (#165 stays
 * intact: no multi-index scan is introduced). #107 (QR camera scanner) is client-side only (no new
 * message action) — it decodes a QR frame in the popup/fullscreen UI and fills the existing
 * `send.recipient`/offer fields.
 *
 * v27 (#95/#96/#115 — accounts, watch-only + private-key export, keystore file backup/restore):
 * `addAccount`/`renameAccount`/`removeAccount` manage NAMED sub-accounts (distinct derivation
 * indices, #95) under one wallet's existing single-active-index model (#165 unchanged — an account
 * is a friendly bookmark over one index, never a second scan dimension); `listWallets`'s per-wallet
 * metadata now always carries `accounts` (defaulted). `importWatchWallet` adds a spend-less
 * watch-only wallet from a public key only (#96); `getReceiveAddress`/`scanBalances`/
 * `listDerivedAddresses` accept it directly for a watch-only active wallet (unhardened only); every
 * signing-required action rejects a watch-only active wallet with `WATCH_ONLY`.
 * `exportPrivateKey` reveals the raw (pre-synthetic) account secret key at the active index (both
 * schemes) behind the same full-password re-auth as `revealPhrase`. `exportWalletBackup`/
 * `importWalletBackup` move a wallet's existing encrypted DIGWX1 record as a downloadable file
 * (#115) — the SW never decrypts it either way.
 *
 * v28 (#97 CAT issuance): added `prepareCatIssuance` (build + hold a brand-new CAT issuance — single
 * fixed-supply genesis-by-coin-id TAIL, or multi signature-gated TAIL curried with the wallet's own
 * key — for approval) and `confirmCatIssuance` (sign + broadcast the approved issuance — reuses the
 * vault's `confirmSend` broadcast path).
 *
 * v29 (#104 option contracts): added `prepareOptionMint`/`confirmOptionMint` (mint a new
 * XCH-denominated option — writer AND initial holder), `prepareOptionExercise`/
 * `confirmOptionExercise` (exercise one this wallet holds), and `getOptions` (the local option
 * registry, mirroring #101's offer-log — a bare on-chain option carries no recoverable terms, so the
 * minting wallet remembers them). Both confirm actions reuse the vault's `confirmSend` broadcast path.
 *
 * v30 (#222 auto-detect a running local dig-node): added `getChainSourceStatus` — resolves the
 * §5.3 ladder for the WALLET-data read path (distinct from `getDigNodeStatus`'s content path) and
 * reports the selected mode + the resolved source, backing the "Local dig-node detected" indicator
 * `ChainSourceSetting` shows when Auto mode auto-selects a local node. Purely additive.
 *
 * v31 (#278/#281 dig-node control panel): added the control-panel action set the SW routes to the
 * node's 9778 browser control surface — `getNodeLiveStatus` (the cached `/ws/status` live snapshot,
 * §239), the OPEN cache/LRU family (`cacheGetConfig`, `cacheSetCap`, `cacheList`, `cacheRemove`,
 * `cacheClear`, `cacheStats` — no control token), the pairing controls (`pairingStart`,
 * `pairingState`, `pairingCancel`, `pairingUnpair`), and `controlAuthed` (a single dispatcher that
 * attaches the SW-held paired token to any token-gated `control.*` method — the token is NEVER
 * exposed to a page/UI). Purely additive.
 *
 * v32 (#366 toolbar hide + keyboard show/hide): added `getToolbarShortcut` — a content script
 * cannot call `chrome.commands.getAll()` directly (extension-page-only API), so the injected
 * toolbar asks the SW to resolve the ACTUAL bound key for the `toggle-dig-toolbar` command (falling
 * back to the manifest's `suggested_key.default` when unbound/unresolved), shown as a muted hint in
 * the URN bar. The SW also gained a `chrome.commands.onCommand` listener (no new action — it flips
 * the existing `toolbar.enabled` storage key directly, which both toolbar mounts already react to
 * live via `storage.onChanged`).
 *
 * v34 (#417 auto-consolidate): added `prepareConsolidation` — the recovery step when a send/spend
 * can't be funded within the coin-count cap because the wallet is coin-fragmented. It merges the
 * smallest up-to-cap coins of an asset into one self coin (self-send) and holds the built spend under
 * a pending id; the UI broadcasts it via the existing `confirmSend` and re-tries the original spend.
 * `prepareSend` now funds from a capped, high-value-first selection and may fail with the coded
 * `NEEDS_CONSOLIDATION` / `INSUFFICIENT_FUNDS` (surfaced through the standard failure shape) — no
 * request-field change. Purely additive.
 *
 * v35 (#372/#373 thin-client transport + syncing UI): added `getWalletSyncStatus` — the SW-cached
 * wallet SYNC status pushed by the dig-node over the `/ws` wallet+control transport (SPEC §4.8):
 * `{ state:'syncing'|'synced'|'disconnected', peakHeight, targetHeight }`. The popup hydrates from
 * this on mount and live-patches it from the SW's `walletSyncStatusChanged` broadcast (no polling),
 * driving the first-class syncing / disconnected UI. The wallet READS + `control.*` ops now ride
 * that same socket when it is up (correlated request/response), transparently falling back to the
 * existing HTTP POST path when it is not — purely additive, no action name/shape change. The
 * `chia://` resolver transport is UNCHANGED. Broadcast-only `walletSyncStatusChanged` /
 * `nodeWalletDataChanged` are SW→popup pushes (not ACTIONS, like `nodeLiveStatusChanged`).
 *
 * v36 (#431/#432/#433 node-managed unlock auth + Security tab): added `authRpc` — dispatch an
 * allowlisted `auth.*` method (SPEC §18.24) over the `/ws` transport, backing the fullscreen Security
 * tab (method enroll password/TOTP/passkey, per-transaction vs session-unlock-all mode toggle,
 * session/lock state) + the per-transaction sign-unlock prompt — and `getSignAuthority` — whether the
 * node is the signing authority (the thin-client cutover flag #374) so the sign gate knows to arm the
 * node auth before a spend. Both purely additive.
 */
export const MESSAGE_PROTOCOL_VERSION = 36;

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
  navigateDigInput: 'navigateDigInput', // #362 — classify+resolve+navigate ANY raw entry input
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
  // ── APP-SIGN dig-app paired identity channel (SIGN-4, #950): the UI ↔ SW channel. The connect/
  // sign RELAY ops derive the dapp origin from the browser-committed sender, never from params. ──
  appSignStatus: 'appSignStatus', // { paired, connState } — for the UI paired-state surface
  appSignPair: 'appSignPair', // trigger dig-app's native pairing confirm + store the token
  appSignUnpair: 'appSignUnpair', // delete the local pairing record
  appSignConnect: 'appSignConnect', // relay connect.request with the committed sender origin
  appSignSign: 'appSignSign', // relay sign.request with the committed sender origin
  // ── self-custody wallet (#56): keystore ops the SW routes to the offscreen vault ──
  createWallet: 'createWallet',
  importWallet: 'importWallet',
  unlockWallet: 'unlockWallet',
  lockWallet: 'lockWallet',
  revealPhrase: 'revealPhrase',
  // ── private-key reveal (#96): raw account secret key at the active index, both schemes ──
  exportPrivateKey: 'exportPrivateKey',
  getLockState: 'getLockState',
  // ── multi-wallet switcher (#90): registry over the per-wallet DIGWX1 records ──
  listWallets: 'listWallets',
  switchWallet: 'switchWallet',
  renameWallet: 'renameWallet',
  removeWallet: 'removeWallet',
  // ── watch-only wallets (#96): a spend-less wallet imported from a public key only ──
  importWatchWallet: 'importWatchWallet',
  // ── named accounts (#95): distinct derivation indices under one wallet's seed/key ──
  addAccount: 'addAccount',
  renameAccount: 'renameAccount',
  removeAccount: 'removeAccount',
  // ── encrypted keystore file backup/restore (#115): move a wallet's own DIGWX1 record as a file ──
  exportWalletBackup: 'exportWalletBackup',
  importWalletBackup: 'importWalletBackup',
  // ── single active derivation index (#165): navigate the active wallet's active index ──
  setActiveIndex: 'setActiveIndex',
  getReceiveAddress: 'getReceiveAddress',
  // ── derived-address list (#106): a read-only page of BOTH-scheme addresses for viewing/copying ──
  listDerivedAddresses: 'listDerivedAddresses',
  getCustodyBalances: 'getCustodyBalances',
  prepareSend: 'prepareSend',
  confirmSend: 'confirmSend',
  sendStatus: 'sendStatus',
  getActivity: 'getActivity',
  makeOffer: 'makeOffer',
  inspectOffer: 'inspectOffer',
  prepareTrade: 'prepareTrade',
  confirmTrade: 'confirmTrade',
  // ── saved/active offer management (#101): the local "your offers" log + derived status ──
  getOffers: 'getOffers',
  // ── self-custody NFTs / Collectibles (#56): routed to the offscreen vault ──
  listNfts: 'listNfts',
  prepareNftTransfer: 'prepareNftTransfer',
  confirmNftTransfer: 'confirmNftTransfer',
  // ── NFT collection metadata + richer gallery (#98): handled DIRECTLY by the SW, not the vault ──
  getNftMetadata: 'getNftMetadata',
  // ── Collectibles multi-select bulk transfer/burn (#171; confirm reuses the confirmSend path) ──
  prepareNftBulkTransfer: 'prepareNftBulkTransfer',
  confirmNftBulkTransfer: 'confirmNftBulkTransfer',
  prepareNftBulkBurn: 'prepareNftBulkBurn',
  confirmNftBulkBurn: 'confirmNftBulkBurn',
  // ── NFT minting (#92): build a new NFT + broadcast (confirm reuses the confirmSend path) ──
  prepareNftMint: 'prepareNftMint',
  confirmNftMint: 'confirmNftMint',
  // ── CAT issuance (#97): mint a brand-new CAT + broadcast (confirm reuses the confirmSend path) ──
  prepareCatIssuance: 'prepareCatIssuance',
  confirmCatIssuance: 'confirmCatIssuance',
  // ── Option contracts (#104): mint/exercise + broadcast (confirm reuses the confirmSend path) ──
  prepareOptionMint: 'prepareOptionMint',
  confirmOptionMint: 'confirmOptionMint',
  prepareOptionExercise: 'prepareOptionExercise',
  confirmOptionExercise: 'confirmOptionExercise',
  getOptions: 'getOptions',
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
  // ── bulk-assign a wallet-owned DID as MULTIPLE NFTs' owner in one spend (#99; confirm reuses confirmSend) ──
  prepareNftBulkDidAssign: 'prepareNftBulkDidAssign',
  confirmNftBulkDidAssign: 'confirmNftBulkDidAssign',
  // ── coin control (#91): per-asset coin listing + split / combine (confirmed via confirmSend) ──
  listCoins: 'listCoins',
  prepareSplit: 'prepareSplit',
  prepareCombine: 'prepareCombine',
  // ── auto-consolidate (#417): merge the smallest up-to-cap coins so a fragmented wallet can fund a
  // spend that hit the coin-count cap (confirmed via confirmSend) ──
  prepareConsolidation: 'prepareConsolidation',
  // ── clawback (#152): list pending incoming/outgoing + claim (receiver) / claw back (sender);
  // confirmed via confirmSend. Send-WITH-clawback is prepareSend's own `clawbackSeconds` field. ──
  listClawbacks: 'listClawbacks',
  prepareClawbackAction: 'prepareClawbackAction',
  confirmClawbackAction: 'confirmClawbackAction',
  // ── in-window app-view (#66): install/remove the on.dig.net framing bypass DNR rule ──
  appViewFraming: 'appViewFraming',
  // ── verification + node status ──
  reportVerification: 'reportVerification',
  getVerification: 'getVerification',
  getDigNodeStatus: 'getDigNodeStatus',
  // ── wallet-data source auto-detect (#222): the §5.3 ladder status for the WALLET read path ──
  getChainSourceStatus: 'getChainSourceStatus',
  // ── dig-dns Path-B proxy fallback (#175): the shared .dig-resolution availability signal ──
  getDigDnsStatus: 'getDigDnsStatus',
  // ── DIG Shields (per-resource proof ledger) — mirrors the browser dig://shields #134 ──
  recordLedgerEntry: 'recordLedgerEntry',
  getShieldLedger: 'getShieldLedger',
  // ── server-side verification ledger (#307): the local dig-node's authoritative per-resource
  // verdict + Merkle inclusion-proof data for the active page (GET /verify/<storeId>[:<root>]),
  // consumed by the aggregate "Verified by Chia" badge + the proof-inspection modal ──
  getVerifyLedger: 'getVerifyLedger',
  // ── creator tips (#379, child of #377): one-tap manual $DIG tip for the active DIG resource's
  // creator, routed to the node tipping subsystem's `tip.manual` (SPEC §18.23) over the /ws transport. ──
  tipCreator: 'tipCreator',
  // ── Tip tab (#380): the node tipping config/ledger/manual surface (`tip.*`, SPEC §18.23) over /ws.
  // Method-allowlisted dispatcher: open reads (get_config/get_ledger) + token-gated mutations
  // (set_config/manual). Backs the fullscreen Tip tab (history, auto-tip management, one-tap tip). ──
  tipRpc: 'tipRpc',
  // ── Node-managed unlock auth (#431/#432/#433, SPEC §18.24): dispatch an `auth.*` method (status,
  // mode/method policy, TOTP/passkey enroll, unlock/sign_unlock/lock) over the /ws transport. Backs
  // the fullscreen Security tab + the per-transaction sign-unlock prompt. Every method is paired-token
  // gated (§7.12); the socket attaches the paired token. ──
  authRpc: 'authRpc',
  // ── Whether the dig-node is the signing AUTHORITY on this caller (thin-client cutover flag, #374):
  // true ⇒ node custody + node signing ⇒ a spend must first arm the node auth gate (auth.sign_unlock).
  // OFF by default ⇒ local-vault custody, no node auth gate. Read by the per-transaction unlock gate. ──
  getSignAuthority: 'getSignAuthority',
  // ── DIG Control Panel (node management) — mirrors the browser dig://control ──
  getControlStatus: 'getControlStatus',
  // ── dig-node control panel (#278/#281): live WS status, OPEN cache/LRU, pairing, authed control ──
  getNodeLiveStatus: 'getNodeLiveStatus',
  // ── thin-client wallet sync status (#372/#373): the /ws-pushed syncing|synced|disconnected state ──
  getWalletSyncStatus: 'getWalletSyncStatus',
  cacheGetConfig: 'cacheGetConfig',
  cacheSetCap: 'cacheSetCap',
  cacheList: 'cacheList',
  cacheRemove: 'cacheRemove',
  cacheClear: 'cacheClear',
  cacheStats: 'cacheStats',
  pairingStart: 'pairingStart',
  pairingState: 'pairingState',
  pairingCancel: 'pairingCancel',
  pairingUnpair: 'pairingUnpair',
  controlAuthed: 'controlAuthed',
  // ── diagnostics ──
  reportError: 'reportError',
  reportSuccess: 'reportSuccess',
  // ── dexie marketplace integration (#102): NOT a custody action — no wallet key involved, handled
  // directly by the SW (mirrors getNftMetadata's off-chain-fetch pattern) ──
  dexiePost: 'dexiePost',
  dexieBrowse: 'dexieBrowse',
  dexieResolve: 'dexieResolve',
  // ── search engine ──
  addSearchEngine: 'addSearchEngine',
  getDefaultSearchEngine: 'getDefaultSearchEngine',
  isDigSearchDefault: 'isDigSearchDefault',
  updateSearchConfig: 'updateSearchConfig',
  // ── self-description ──
  getCapabilities: 'getCapabilities',
  // ── injected page toolbar (#292): the content script asks the SW to open a full-page extension
  // surface in a NEW tab (a content script has no `tabs` permission of its own) ──
  openExtensionPage: 'openExtensionPage',
  // ── toolbar hide + keyboard show/hide (#366): resolve the ACTUAL bound chrome.commands
  // shortcut (a content script has no `chrome.commands` access — only extension pages / the SW do) ──
  getToolbarShortcut: 'getToolbarShortcut',
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
    summary:
      "Run the §5.3 node-or-sandbox navigation (handleDigUrlNavigation) for a chia:// URL against the sender (or active) tab: a reachable local dig-node lands the tab on its plaintext /s/ serve surface (#289); otherwise the sandbox dig-viewer. Callers: the home open-by-URN input, the injected page toolbar's URN bar (#293), and the `dig` omnibox.",
    request: '{ action, url:string }',
    response: `{ success:true, url:viewerUrl } | ${CODED_ERROR}`,
  },
  [ACTIONS.navigateDigInput]: {
    summary:
      "Classify + resolve + navigate ANY raw entry-surface input against the sender (or active) tab (#362): the shared classifier (dig-nav classifyDigInput) decides a DIG address (chia:// / urn:dig:chia: / bare store id / dig-dns .dig) → the §5.4 node-or-sandbox nav; an *.on.dig.net / <name>.dig subdomain → HEAD→URN (#308, resolved from the extension origin) → the §5.4 nav; a plain URL → navigate to it; free text → the configurable fallback search engine (search-fallback). Callers: the raw urn:/chia:// URL-bar interception (#310), the toolbar URN bars' on-dig-net form (#306), the `dig` omnibox, and the custom DIG search resolver page (#362).",
    request: '{ action, input:string }',
    response: `{ success:true } | ${CODED_ERROR}`,
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
  [ACTIONS.appSignStatus]: {
    summary: 'APP-SIGN (SIGN-4, #950): report the dig-app pairing + channel-connection state for the UI.',
    request: '{ action }',
    response: '{ ok:true, data:{ paired:boolean, connState } }',
  },
  [ACTIONS.appSignPair]: {
    summary: 'APP-SIGN (#950): trigger dig-app’s native pairing confirm and store the channel token.',
    request: '{ action }',
    response: '{ ok:true } | { ok:false, code, message }',
  },
  [ACTIONS.appSignUnpair]: {
    summary: 'APP-SIGN (#950): delete the local dig-app pairing record (the local half of unpair).',
    request: '{ action }',
    response: '{ ok:true }',
  },
  [ACTIONS.appSignConnect]: {
    summary:
      'APP-SIGN (#950): relay a dapp connect.request to dig-app with the browser-COMMITTED sender origin (never a page-supplied string).',
    request: '{ action, params:{ dappName?, dappIconUrl?, requestedPermissions? } }',
    response: '{ ok:true, data:{ granted, profile_did?, addresses?, pubkeys? } } | { ok:false, code, message }',
  },
  [ACTIONS.appSignSign]: {
    summary:
      'APP-SIGN (#950): relay a dapp sign.request to dig-app with the browser-COMMITTED sender origin; dig-app raises the native confirm and returns only the signature.',
    request: '{ action, params:{ payloadType, payloadB64, decodeHint?, context? } }',
    response: '{ ok:true, data:{ signature_b64, pubkey_hex } } | { ok:false, code, message }',
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
  [ACTIONS.exportPrivateKey]: {
    summary:
      "Private-key reveal (#96): show the raw (pre-synthetic) account secret key at the ACTIVE HD derivation index, BOTH schemes. Re-runs the FULL password unlock exactly like revealPhrase (never from the TTL window). This is the key convention Sage/chia-blockchain/hardware wallets treat as \"the wallet key\" for an address — they re-apply the synthetic offset themselves. Refused (WATCH_ONLY) for a watch-only active wallet (it holds no secret at all).",
    request: '{ action, password:string }',
    response:
      "{ privateKeys:[{ scheme:'unhardened'|'hardened', hex:string }] } | { success:false, code:'UNLOCK_FAILED'|'WATCH_ONLY', message }",
  },
  [ACTIONS.getLockState]: {
    summary: "Report the wallet lock state: 'none' (no wallet), 'locked' (wallet exists, key not in memory / TTL expired), or 'unlocked'. Also carries the active wallet's active HD derivation index (#165) so the index navigator hydrates from this same poll.",
    request: '{ action }',
    response: "{ lockState:'none'|'locked'|'unlocked', activeWalletId?:string, unlockExpiry?:number, activeIndex?:number }",
  },
  [ACTIONS.listWallets]: {
    summary:
      "Multi-wallet (#90): list the wallet registry as record-FREE metadata (id, label, createdAt, active, activeIndex, accounts — #95's named sub-accounts, always populated) + the active id. A watch-only entry (#96) also carries kind:'watch' + its key fingerprint. The encrypted DIGWX1 records never leave the SW.",
    request: '{ action }',
    response: "{ wallets:[{ id, label, createdAt, active:boolean, activeIndex:number, accounts:[{id,label,index}], kind?:'watch', watchFingerprint?:number }], activeWalletId:string|null } | { success:false, code, message }",
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
  [ACTIONS.importWatchWallet]: {
    summary:
      'Watch-only wallets (#96): add a spend-less wallet from a master/root BLS public key only (hex) — NO password, NO seed, never "locked" (there is nothing to unlock). Every address/balance derives from the public key, UNHARDENED ONLY (hardened is unreachable from a public key alone). Validates the key + previews its index-0 address + Chia-convention fingerprint before adding it, active, to the registry.',
    request: '{ action, publicKeyHex:string /* 48 bytes / 96 hex chars */, label?:string }',
    response: "{ success:true, activeWalletId:string, address:string, fingerprint:number } | { success:false, code:'INVALID_PUBLIC_KEY', message }",
  },
  [ACTIONS.addAccount]: {
    summary:
      "Named accounts (#95): append a new named sub-account to the ACTIVE wallet at the next unused HD derivation index (one above the highest index any of its existing accounts already bookmarks). Purely local metadata over the single-active-index model (#165 unchanged — an account is a friendly bookmark over one index, not a second scan dimension).",
    request: '{ action, label?:string }',
    response: "{ success:true, accounts:[{ id, label, index }] } | { success:false, code:'NO_WALLET', message }",
  },
  [ACTIONS.renameAccount]: {
    summary: 'Named accounts (#95): rename one account of the ACTIVE wallet (metadata only).',
    request: '{ action, accountId:string, label:string }',
    response: "{ success:true, accounts:[{ id, label, index }] } | { success:false, code:'NO_WALLET'|'BAD_REQUEST', message }",
  },
  [ACTIONS.removeAccount]: {
    summary:
      "Named accounts (#95): remove one account of the ACTIVE wallet, refusing to drop the last remaining one. Removing the currently-ACTIVE account (its index === the wallet's activeIndex) re-homes activeIndex to the first remaining account, invalidating every index-scoped view exactly like setActiveIndex.",
    request: '{ action, accountId:string }',
    response: "{ success:true, accounts:[{ id, label, index }] } | { success:false, code:'NO_WALLET'|'LAST_ACCOUNT', message }",
  },
  [ACTIONS.exportWalletBackup]: {
    summary:
      "Encrypted keystore file backup (#115): package ONE wallet's own existing at-rest DIGWX1 record as a downloadable JSON envelope (its OWN magic/version). The SW never decrypts it — the embedded record is copied byte-for-byte, so the file is only ever as sensitive as the encrypted blob already persisted (still requires the ORIGINAL password to ever unlock, wherever it's restored).",
    request: '{ action, walletId:string }',
    response: "{ success:true, filename:string, json:string } | { success:false, code:'NO_WALLET'|'WATCH_ONLY', message }",
  },
  [ACTIONS.importWalletBackup]: {
    summary:
      "Encrypted keystore file backup (#115): restore a wallet from a previously-exported backup file's JSON text. Validates the envelope + its embedded DIGWX1 record structurally (never decrypts it) and adds it, active, to the registry under a FRESH id — it comes back LOCKED (no password was ever seen), so the normal unlock screen prompts for its original password. Refuses a byte-identical duplicate already in the registry.",
    request: '{ action, json:string, label?:string }',
    response: "{ success:true, activeWalletId:string, lockState:'locked' } | { success:false, code:'BAD_FORMAT'|'BAD_RECORD'|'ALREADY_EXISTS', message }",
  },
  [ACTIONS.setActiveIndex]: {
    summary: 'Single active derivation index (#165): navigate the ACTIVE wallet\'s active HD derivation index (prev/next/jump — the caller computes the target index and sends it absolute). A pure SW registry op (no vault round-trip); persisted per wallet; drops the balance/activity caches (scoped to the previous index).',
    request: '{ action, index:number }',
    response: "{ success:true, activeIndex:number } | { success:false, code:'NO_WALLET', message }",
  },
  [ACTIONS.getReceiveAddress]: {
    summary: 'Derive the wallet\'s receive address for the ACTIVE HD derivation index (unhardened, #165) in the offscreen vault. Requires an unlocked wallet.',
    request: '{ action }',
    response: "{ address:string } | { success:false, code:'LOCKED'|..., message }",
  },
  [ACTIONS.listDerivedAddresses]: {
    summary: "Derive a read-only PAGE of the active wallet's addresses (#106) — BOTH HD schemes, indexes 0..count-1 — for VIEWING/COPYING in an Advanced list. Pure local derivation (no chain query, no balance scan); NOT a multi-index sweep (#165's single-active-index model is unaffected — this never drives a balance/activity view). `count` defaults to a small page and is clamped server-side.",
    request: '{ action, count?:number /* per scheme; default a small page, clamped to a server max */ }',
    response: "{ addresses:[{ index:number, scheme:'unhardened'|'hardened', address:string }] } | { success:false, code:'LOCKED'|..., message }",
  },
  [ACTIONS.getCustodyBalances]: {
    summary: 'Scan self-custody balances (both HD schemes) AT THE ACTIVE INDEX (#165) from coinset for XCH + watched CATs. Cached to walletCache.balances; returns the cached snapshot on a transient scan failure.',
    request: '{ action }',
    response: "{ balances:{ xch:number, cats:{ [assetId]:number } }, cached?:boolean } | { success:false, code, message }",
  },
  [ACTIONS.prepareSend]: {
    summary: 'Build (not sign/broadcast) an XCH or CAT send in the offscreen vault; hold it under a pending id and return the decoded (tamper-resistant) summary to approve. A CAT send carries the token TAIL as assetId (omitted / "xch" = native XCH); the vault routes on assetId (#121). An optional coinIds hand-picks which coins fund the send, overriding auto-selection (#91). An optional clawbackSeconds (#152, XCH only) sends WITH a reclaimable timelock instead of a plain send — an absolute unix timestamp after which the receiver may claim; strictly before it, only the sender may claw back. An optional memo (#105) attaches a plain-text note to the recipient\'s CREATE_COIN — PUBLIC on chain, capped at 512 UTF-8 bytes, and mutually exclusive with clawbackSeconds (both reject with BAD_REQUEST).',
    request: '{ action, recipient:string /* xch1… */, amount:string /* base units */, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */, coinIds?:string[] /* hex; hand-picked funding coins */, clawbackSeconds?:string /* absolute unix timestamp; XCH only */, memo?:string /* ≤512 UTF-8 bytes; public on chain */ }',
    response: "{ pendingId:string, summary:{ asset:'XCH'|<assetId>, sent, change, fee, recipientPuzzleHashHex, coinCount, memoText?:string }, clawbackInfo?:{ senderPuzzleHashHex, receiverPuzzleHashHex, seconds, amount } } | { success:false, code, message }",
  },
  [ACTIONS.confirmSend]: {
    summary: 'Sign + BROADCAST a previously-prepared send (the approved step — the only place a real spend is pushed). Returns an input coin id to poll, plus a #154 activityHint (asset/amount/counterparty captured at prepare time) the SW logs to the local activity log as a `sent` entry — absent a counterparty (a self-only split/combine reusing this path), nothing is logged.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string, activityHint?:{ asset, amount, counterparty:string|null } } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.sendStatus]: {
    summary: 'Poll whether a broadcast send has confirmed (an input coin is now recorded spent). #154: a `confirmed:true` result flips the matching local activity-log entry from `pending` to `confirmed`.',
    request: '{ action, coinId:string }',
    response: '{ confirmed:boolean } | { success:false, code, message }',
  },
  [ACTIONS.getActivity]: {
    summary: "#154 — the LOCAL activity log for the ACTIVE wallet + active index (#165): an instant chrome.storage.local read, NOT an on-chain scan. Entries are written the moment the extension performs an action (send/mint/DID/trade — see confirmSend/confirmTrade), starting `pending` until sendStatus confirms them; a `received` entry is detected from the balance scan's own before/after delta (getCustodyBalances).",
    request: '{ action }',
    response: "{ events:[{ id, kind:'sent'|'received'|'mint'|'did'|'offer'|'trade'|'clawback'|'melt', asset, amount, counterparty, coinId, timestamp, status:'pending'|'confirmed' }] } | { success:false, code, message }",
  },
  [ACTIONS.makeOffer]: {
    summary: "Build (not broadcast) a shareable trade offer in the offscreen vault: spend the offered asset(s) into the settlement puzzle + assert the requested payment(s); returns the `offer1…` string + two-sided summary. `offered`/`requested` are ARRAYS (#100) — 1 or more legs per side, any mix of XCH/CAT on either side plus at most one offered NFT; no asset may repeat within a side (DUPLICATE_ASSET) or appear on both sides (SAME_ASSET). Offering an NFT (#94, OFFERED side only) with a nonzero on-chain royalty automatically declares the CHIP-0011 sale trade-price so the taker's royalty payment is chain-enforced. A `requested` leg with `asset.kind:'nft'` is rejected with UNSUPPORTED_REQUEST (buying a specific NFT is a tracked follow-up); there is no `did` asset kind (DID is not an offer asset — see offers.ts).",
    request: "{ action, offered:[{ asset:{kind:'xch'}|{kind:'cat',assetId}|{kind:'nft',launcherId}, amount:string }, ...], requested:[{ asset:{kind:'xch'}|{kind:'cat',assetId}, amount:string }, ...], fee?:string }",
    response: "{ offer:string /* offer1… */, offerSummary:{ offered:[{asset,amount}], requested:[{asset,amount,toPuzzleHashHex}] }, offerCoinIds?:string[] } | { success:false, code:'UNSUPPORTED_REQUEST'|'DUPLICATE_ASSET'|'SAME_ASSET'|..., message }",
  },
  [ACTIONS.inspectOffer]: {
    summary: 'Decode an `offer1…` string to its two-sided (offered vs requested) summary in the offscreen vault. Read-only; no broadcast. An offered NFT leg (#94) decodes to `{kind:"nft",launcherId}` at amount 1.',
    request: '{ action, offerStr:string }',
    response: '{ offerSummary:{ offered:[{asset,amount}], requested:[{asset,amount,toPuzzleHashHex}] } } | { success:false, code, message }',
  },
  [ACTIONS.prepareTrade]: {
    summary: 'Build + sign (not broadcast) a TAKE (fund + accept) or CANCEL (reclaim) of an offer; hold it under a pending id and return the two-sided summary to approve.',
    request: "{ action, offerStr:string, tradeKind:'take'|'cancel', fee?:string }",
    response: '{ pendingId:string, offerSummary:{ offered, requested } } | { success:false, code, message }',
  },
  [ACTIONS.confirmTrade]: {
    summary: 'BROADCAST a previously-prepared trade (the approved step — the only place a trade is pushed). Returns an input coin id to poll, plus a #154 activityHint the SW logs as a `trade` entry (always present, even for a cancel). A CANCEL also eagerly flips the matching #101 offer-log entry to `cancelled` (never waits for the next getOffers poll to guess `taken`).',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string, activityHint:{ asset, amount, counterparty:null } } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.getOffers]: {
    summary: "The LOCAL offer log (#101) for the ACTIVE wallet + active index (#165): every offer this wallet has MADE via makeOffer, newest first, with derived status. Before returning, reconciles every still-`open` entry against the chain (a cheap coin-spent check per entry, mirroring sendStatus) — a coin spent WITHOUT this wallet having cancelled it flips to `taken`; a cancel is flipped eagerly by confirmTrade instead of waiting for this poll. See src/lib/offer-log.ts.",
    request: '{ action }',
    response: "{ offers:[{ id, offer, summary:{ offered, requested }, coinIdHex, createdAt, status:'open'|'taken'|'cancelled'|'expired' }] }",
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
  [ACTIONS.getNftMetadata]: {
    summary: "Fetch + JSON-decode the off-chain CHIP-0007 metadata document at `uri` (#98 — a `metadataUri` from listNfts, gateway-rewritten by the caller if it was ipfs://). Handled directly in the SW (not the offscreen vault) as a simple no-vault read; the host is arbitrary and not enumerable in advance, so the manifest's CSP connect-src/host_permissions are widened to any https host (matching img-src's existing breadth for NFT art). GET-only, size- and time-capped. Returns the RAW decoded JSON — the caller validates/shapes it via parseNftOffchainMetadata (src/lib/nft-offchain-metadata.ts) since this is untrusted third-party content. Read-only.",
    request: '{ action, uri:string /* http(s):// */ }',
    response: "{ metadata:unknown } | { success:false, code:'BAD_REQUEST'|'FETCH_FAILED'|'TOO_LARGE'|'INVALID_JSON'|'TIMEOUT'|'NETWORK_ERROR', message }",
  },
  [ACTIONS.prepareNftBulkTransfer]: {
    summary: "Build (not sign/broadcast) a transfer of MULTIPLE selected NFTs to one recipient in a SINGLE spend bundle (#171 — Collectibles multi-select). Hold under a pending id and return the decoded bulk summary to approve. The recipient's p2 puzzle hash is carried as the create-coin hint for every NFT.",
    request: '{ action, launcherIds:string[] /* hex, ≥1 */, recipient:string /* xch1… */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, nftBulkSummary:{ launcherIds, recipientPuzzleHashHex, fee, coinCount, isBurn:false } } | { success:false, code:\'NO_NFTS_SELECTED\'|\'NFT_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmNftBulkTransfer]: {
    summary: 'Sign + BROADCAST a previously-prepared bulk NFT transfer (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareNftBulkBurn]: {
    summary: "Build (not sign/broadcast) a BURN of MULTIPLE selected NFTs — a transfer to the well-known provably-unspendable puzzle hash (30 zero bytes + 0xDEAD, the standard Chia-ecosystem burn destination) in a SINGLE spend bundle (#171 — Collectibles multi-select destructive burn). Hold under a pending id and return the decoded bulk summary to approve. Irreversible once confirmNftBulkBurn broadcasts it — the CALLER must gate confirmNftBulkBurn behind an explicit, distinct user confirmation and must NEVER invoke it automatically.",
    request: '{ action, launcherIds:string[] /* hex, ≥1 */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, nftBulkSummary:{ launcherIds, recipientPuzzleHashHex, fee, coinCount, isBurn:true } } | { success:false, code:\'NO_NFTS_SELECTED\'|\'NFT_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmNftBulkBurn]: {
    summary: 'Sign + BROADCAST a previously-prepared bulk NFT burn (the approved, IRREVERSIBLE step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus. The caller must have already obtained explicit, distinct destructive confirmation from the user before calling this.',
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
  [ACTIONS.prepareCatIssuance]: {
    summary: "Build (not sign/broadcast) the ISSUANCE of a brand-new CAT owned by the wallet (#97) — mode:'single' (default) mints a fixed-supply genesis-by-coin-id TAIL that can never be re-minted; mode:'multi' mints an \"everything with signature\" TAIL curried with the wallet's OWN synthetic public key at the active index, so only it can authorize a future re-mint/melt. The minted supply + any XCH change return to the wallet. Held under a pending id; returns the decoded (tamper-resistant) summary + the new asset id to approve. Broadcast via confirmCatIssuance.",
    request: '{ action, catIssuance:{ amount:string /* mojos, base units */, mode?:\'single\'|\'multi\', fee?:string } }',
    response: '{ pendingId:string, assetId:string, catIssuanceSummary:{ assetId, mode, amount, fee, coinCount } } | { success:false, code:\'BAD_REQUEST\'|\'NO_XCH_COINS\'|..., message }',
  },
  [ACTIONS.confirmCatIssuance]: {
    summary: 'Sign + BROADCAST a previously-prepared CAT issuance (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareOptionMint]: {
    summary: 'Build (not sign/broadcast) the MINT of a new XCH-denominated option contract owned by the wallet (#104, writer AND initial holder) — locks underlyingAmount mojos of XCH as collateral, exercisable for strikeAmount mojos of XCH until expirationSeconds (absolute unix time). Held under a pending id; returns the decoded (tamper-resistant) summary + the FULL optionRecord the caller MUST persist locally (a bare on-chain option carries no recoverable terms — the SW records it into the local option registry as a side effect on confirmOptionMint). Broadcast via confirmOptionMint.',
    request: '{ action, optionMint:{ underlyingAmount:string, strikeAmount:string, expirationSeconds:string, fee?:string } }',
    response: '{ pendingId:string, optionMintSummary:{...optionRecord, fee, coinCount}, optionRecord:{ launcherId, creatorPuzzleHashHex, holderPuzzleHashHex, expirationSeconds, underlyingAmount, strikeAmount, underlyingLockParentCoinId, coinIdHex } } | { success:false, code:\'BAD_REQUEST\'|\'NO_XCH_COINS\'|..., message }',
  },
  [ACTIONS.confirmOptionMint]: {
    summary: "Sign + BROADCAST a previously-prepared option mint (the approved step — reuses the vault confirmSend broadcast path). Records the option into the local registry (#104, mirrors #101's offer-log) as a side effect. Returns an input coin id to poll via sendStatus.",
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.prepareOptionExercise]: {
    summary: 'Build (not sign/broadcast) the EXERCISE of an option this wallet holds (#104): melt the option singleton, pay the strike to the creator through the settlement puzzle, unlock the underlying, and claim the released value to the holder — all in one bundle. `optionRecord` (the caller\'s persisted registry entry, from getOptions) is REQUIRED. Held under a pending id; returns the decoded summary to approve. Broadcast via confirmOptionExercise.',
    request: '{ action, optionRecord:{ launcherId, creatorPuzzleHashHex, holderPuzzleHashHex, expirationSeconds, underlyingAmount, strikeAmount, underlyingLockParentCoinId, coinIdHex }, fee?:string }',
    response: '{ pendingId:string, optionExerciseSummary:{ launcherId, strikeAmount, underlyingAmount, fee, coinCount } } | { success:false, code:\'OPTION_NOT_FOUND\'|\'EXPIRED\'|\'MISSING_KEY\'|\'NO_SUITABLE_COIN\'|..., message }',
  },
  [ACTIONS.confirmOptionExercise]: {
    summary: "Sign + BROADCAST a previously-prepared option exercise (the approved step — reuses the vault confirmSend broadcast path). Flips the local registry entry to 'exercised' (#104) as a side effect. Returns an input coin id to poll via sendStatus.",
    request: '{ action, pendingId:string }',
    response: "{ spentCoinId:string } | { success:false, code:'PUSH_FAILED'|'NO_PENDING'|..., message }",
  },
  [ACTIONS.getOptions]: {
    summary: "The LOCAL option registry (#104) for the active wallet + active index — every option THIS wallet has minted, reconciled against the chain (a still-'open' entry whose coin is now spent flips to 'exercised'). An instant read + best-effort chain reconciliation, mirroring getOffers (#101). Read-only.",
    request: '{ action }',
    response: '{ options:[{ record:{...}, createdAt:number, status:\'open\'|\'exercised\' }] }',
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
  [ACTIONS.prepareNftBulkDidAssign]: {
    summary: "Build (not sign/broadcast) assigning the wallet's DID as the OWNER of MULTIPLE selected NFTs in ONE spend bundle (#99 — Collectibles multi-select assign-DID). Generalizes prepareNftDidAssign: each NFT emits its own CHIP-0011 TransferNft + announcement, the DID is spent ONCE asserting every one of them. launcherIds is deduped + MUST be non-empty (NO_NFTS_SELECTED); any NFT not held fails the whole prepare (NFT_NOT_FOUND) — builds completely or not at all. Neither NFT nor DID custody changes; a fee is paid once from a separate XCH coin.",
    request: '{ action, launcherIds:string[] /* the NFTs, hex, ≥1 */, didLauncherId:string /* hex */, fee?:string /* mojos */ }',
    response: '{ pendingId:string, nftBulkDidAssignSummary:{ nftLauncherIds, didLauncherId, fee, coinCount } } | { success:false, code:\'NO_NFTS_SELECTED\'|\'NFT_NOT_FOUND\'|\'DID_NOT_FOUND\'|..., message }',
  },
  [ACTIONS.confirmNftBulkDidAssign]: {
    summary: 'Sign + BROADCAST a previously-prepared bulk NFT↔DID assignment (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
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
  [ACTIONS.prepareConsolidation]: {
    summary: 'Build (not sign/broadcast) an auto-CONSOLIDATION (#417): merge the SMALLEST up-to-cap coins of an asset into a single self coin so a coin-fragmented wallet can then fund a spend that selectCoins rejected as NEEDS_CONSOLIDATION. Holds it under a pending id; returns the decoded (self-send-verified) summary. Broadcast via confirmSend, then re-try the original send. Routed on assetId (#121).',
    request: '{ action, fee?:string /* mojos */, assetId?:string /* CAT TAIL hex; omit for native XCH */ }',
    response: "{ pendingId:string, coinOpSummary:{ asset, kind:'combine', inputCoinCount, outputCoinCount, total, fee } } | { success:false, code:'NOTHING_TO_CONSOLIDATE'|..., message }",
  },
  [ACTIONS.listClawbacks]: {
    summary: "List the wallet's currently-pending clawbacks (#152): INCOMING (discovered on chain by hint at the active index's own addresses) plus OUTGOING (checked against LIVE chain state from the caller's own clawbackCandidates — sourced from the local activity log's 'clawback' entries, since the vault has no other way to enumerate a wallet's past clawback sends). Read-only.",
    request: '{ action, clawbackCandidates?:[{ senderPuzzleHashHex, receiverPuzzleHashHex, seconds:string, amount:string }] }',
    response: "{ clawbacks:[{ direction:'incoming'|'outgoing', info:{ senderPuzzleHashHex, receiverPuzzleHashHex, seconds, amount }, coinIdHex }] } | { success:false, code, message }",
  },
  [ACTIONS.prepareClawbackAction]: {
    summary: "Build (not sign/broadcast) the CLAIM (receiver) or CLAW BACK (sender) spend for one pending clawback (#152); hold it under a pending id. The actor's own key must own the relevant side (MISSING_KEY otherwise); the locked coin must currently be pending on chain (NO_CLAWBACK_COIN otherwise). Broadcast via confirmClawbackAction.",
    request: "{ action, direction:'claim'|'reclaim', clawbackInfo:{ senderPuzzleHashHex, receiverPuzzleHashHex, seconds:string, amount:string }, fee?:string /* mojos, reserved out of the coin itself */ }",
    response: '{ pendingId:string, clawbackAmountOut:string /* == amount - fee, delivered to the actor\'s own address */ } | { success:false, code, message }',
  },
  [ACTIONS.confirmClawbackAction]: {
    summary: 'Sign + BROADCAST a previously-prepared clawback claim/claw-back (the approved step — reuses the vault confirmSend broadcast path). Returns an input coin id to poll via sendStatus.',
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
  [ACTIONS.getChainSourceStatus]: {
    summary:
      "Wallet-data source auto-detect (#222): resolve the §5.3 ladder for the WALLET read path (distinct from getDigNodeStatus's content path) and report the selected mode + the resolved source (a reachable node's base/strict, coinset, or unavailable+reason). Backs the 'Local dig-node detected' indicator ChainSourceSetting shows when Auto mode auto-selects a local node.",
    request: '{ action }',
    response:
      "{ mode:'auto'|'node'|'coinset'|'custom', resolved:{kind:'node',base:string,strict:boolean}|{kind:'coinset'}|{kind:'unavailable',reason:'node-unreachable'|'custom-unreachable'|'custom-missing'|'node-not-tracking'} }",
  },
  [ACTIONS.getDigDnsStatus]: {
    summary:
      'dig-dns Path-B proxy fallback (#175): the shared `.dig`-resolution availability signal — whether dig-dns is reachable, the bound gateway port + PAC URL, and whether the PAC proxy is currently engaged (Path A failed and Path B is covering). The SAME signal backs #172\'s open-by-URN dig-dns-detect branch; nothing re-probes dig-dns on its own.',
    request: '{ action }',
    response:
      "{ phase:'unknown'|'direct'|'proxy'|'unavailable', boundPort:number|null, pacUrl:string|null, loopbackIp:string, proxyActive:boolean, lastProbeAt:number|null, lastError:string|null }",
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
  [ACTIONS.getVerifyLedger]: {
    summary:
      "Server-side verification ledger (#307): fetches the local dig-node's GET /verify/<storeId>[:<root>] for the active tab's capsule — the authoritative per-resource verdict (source local|peer|rpc, verified/failReason) + Merkle inclusion-proof data (leafHash, ordered siblings+directions, leafIndex, proofRoot) + the page aggregate. Backs the \"Verified by Chia\" badge + proof-inspection modal. Fails when no local dig-node is reachable (reads still work; verification inspection needs the node).",
    request: '{ action }',
    response:
      "{ storeId, root, aggregate:{verified,anyRpcFailed,counts:{total,verified,failed,bySource:{local,peer,rpc}}}, resources:[{resourceKey,source,verified,root,proof:{leafHash,siblings:[{hash,dir}],leafIndex,proofRoot},failReason?}] } | { success:false, code, message }",
  },
  [ACTIONS.tipCreator]: {
    summary:
      "Creator tips (#379/#380, child of #377): one-tap manual $DIG tip for the active DIG resource's creator, routed to the dig-node tipping subsystem's `tip.manual` (SPEC §18.23) over the /ws transport. A real broadcast → success + txId; a `skipped` outcome (incl. the #428 pre-broadcaster wallet-unavailable reason) → success:false + code TIP_SKIPPED and the reason.",
    request: '{ action, storeId:string, amountDig:string }',
    response: "{ success:boolean, txId?:string, code?:string, message?:string }",
  },
  [ACTIONS.tipRpc]: {
    summary:
      'Tip tab (#380): dispatch a tip.* method (SPEC §18.23) over the /ws wallet+control transport. Allowlisted: tip.get_config + tip.get_ledger (OPEN reads) and tip.set_config + tip.manual (token-gated mutations — the socket attaches the paired control token; an unpaired/stale token surfaces -32030 so the UI shows a "pair to manage" gate). No node reachable → NODE_UNAVAILABLE.',
    request: "{ action, method:'tip.get_config'|'tip.get_ledger'|'tip.set_config'|'tip.manual', params?:object }",
    response: '<the node tip result> | { success:false, code, error, message }',
  },
  [ACTIONS.authRpc]: {
    summary:
      'Security tab + per-transaction sign-unlock (#431/#432/#433, SPEC §18.24): dispatch an allowlisted auth.* method over the /ws wallet+control transport. Methods: auth.status / auth.get_method (paired reads) · auth.set_mode / auth.set_method / auth.enroll_totp / auth.enroll_passkey_begin / auth.enroll_passkey_finish / auth.unlock / auth.sign_unlock / auth.lock. The socket attaches the paired control token; every method is paired-token gated (§7.12). A wrong wallet password/TOTP is a node 401 (code -32030) — surfaced to the UI as a recoverable credential error, and (unlike controlAuthed) it does NOT clear the pairing token. No node reachable → NODE_UNAVAILABLE.',
    request:
      "{ action, method:'auth.status'|'auth.get_method'|'auth.set_mode'|'auth.set_method'|'auth.enroll_totp'|'auth.enroll_passkey_begin'|'auth.enroll_passkey_finish'|'auth.unlock'|'auth.sign_unlock'|'auth.lock', params?:{ id?:string, password?:string, totp_code?:string, mode?:string, method?:string, response?:object } }",
    response: '<the node auth result (AuthStatus | TotpEnrollment)> | { success:false, code, error, message }',
  },
  [ACTIONS.getSignAuthority]: {
    summary:
      'Whether the dig-node is the signing authority on this caller (thin-client cutover flag #374, feature.thinClientCutover). true ⇒ node custody + node signing ⇒ the per-transaction unlock gate arms the node auth (auth.sign_unlock) before a spend. false (default) ⇒ local-vault custody, no node auth gate.',
    request: '{ action }',
    response: '{ nodeIsSigner:boolean }',
  },
  [ACTIONS.getControlStatus]: {
    summary: 'DIG Control Panel: detect a local dig-node (manage vs install) + best-effort control.status; honest hosted-RPC fallback. Mirrors dig://control.',
    request: '{ action }',
    response: "{ mode:'manage'|'install', localNode:boolean, base:string|null, controlEndpoint:string|null, readFallback:string, status:object|null, authRequired:boolean, controlMethods:string[] }",
  },
  [ACTIONS.getNodeLiveStatus]: {
    summary: 'DIG control panel (#239): the SW-cached live node status from the WS `/ws/status` channel (Connected/Connecting/Disconnected + addr/version). Popup hydrates from this and live-patches from the `nodeLiveStatusChanged` broadcast.',
    request: '{ action }',
    response: "{ state:'connecting'|'connected'|'disconnected', base:string|null, addr:string|null, version:string|null, commit:string|null, updatedAt:number }",
  },
  [ACTIONS.getWalletSyncStatus]: {
    summary: "Thin-client wallet sync status (#372/#373): the SW-cached tri-state the dig-node PUSHES over the `/ws` wallet+control transport (SPEC §4.8). syncing = the node's wallet is catching up (balances/spends not final); synced = normal; disconnected = the socket is down (wallet non-functional for live ops, cached content labeled offline). The popup hydrates from this + live-patches from the `walletSyncStatusChanged` broadcast (no polling).",
    request: '{ action }',
    response: "{ state:'syncing'|'synced'|'disconnected', peakHeight:number|null, targetHeight:number|null, updatedAt:number }",
  },
  [ACTIONS.cacheGetConfig]: {
    summary: 'OPEN cache.getConfig on the local node (no token): reserved cap + live usage.',
    request: '{ action }',
    response: "{ cap_bytes:number, used_bytes:number, cache_dir:string, shared:boolean } | { success:false }",
  },
  [ACTIONS.cacheSetCap]: {
    summary: 'OPEN cache.setCapBytes (no token): set the reserved cache cap (node floors at 64 MiB).',
    request: '{ action, capBytes:number }',
    response: '{ cap_bytes:number } | { success:false }',
  },
  [ACTIONS.cacheList]: {
    summary: 'OPEN cache.listCached (no token): cached capsules with size + last-access + lru_rank (0 = next evicted).',
    request: '{ action }',
    response: '{ cached: Array<{capsule,store_id,root,size_bytes,last_used_unix_ms,lru_rank}> } | { success:false }',
  },
  [ACTIONS.cacheRemove]: {
    summary: 'OPEN cache.removeCached (no token): evict one cached capsule by store_id + root.',
    request: '{ action, storeId:string, root:string }',
    response: '{ removed:boolean } | { success:false }',
  },
  [ACTIONS.cacheClear]: {
    summary: 'OPEN cache.clear (no token): delete all locally cached DIG content.',
    request: '{ action }',
    response: '{} | { success:false }',
  },
  [ACTIONS.cacheStats]: {
    summary: 'OPEN cache.stats (no token): cap/used, entry_count/total_bytes, session evicted + content-cache hit/miss.',
    request: '{ action }',
    response: '{ cap_bytes,used_bytes,entry_count,total_bytes,evicted_count,evicted_bytes,content_cache:{hits,misses} } | { success:false }',
  },
  [ACTIONS.pairingStart]: {
    summary: 'Control-token pairing (#280): begin a pairing (OPEN pairing.request → await operator approval → poll). Returns the current pairing state.',
    request: '{ action }',
    response: "{ phase:'requesting'|'awaiting'|'paired'|'expired'|'error', pairingId:string|null, pairingCode:string|null, expiresMs:number|null, error:string|null }",
  },
  [ACTIONS.pairingState]: {
    summary: 'Control-token pairing (#280): the current pairing phase (the token value is never returned).',
    request: '{ action }',
    response: "{ phase:'unpaired'|'requesting'|'awaiting'|'paired'|'expired'|'error', pairingId, pairingCode, expiresMs, error }",
  },
  [ACTIONS.pairingCancel]: {
    summary: 'Control-token pairing (#280): cancel an in-flight pairing (back to unpaired/paired).',
    request: '{ action }',
    response: '{ phase }',
  },
  [ACTIONS.pairingUnpair]: {
    summary: 'Control-token pairing (#280): clear the stored controller token locally (unpair). Node-side revoke is the operator\'s `dig-node pair revoke`.',
    request: '{ action }',
    response: "{ phase:'unpaired' }",
  },
  [ACTIONS.controlAuthed]: {
    summary: 'Authed control.* call (#281): drive a token-gated control method with the stored paired token as X-Dig-Control-Token. On -32030 the SW clears the stale token (returns to unpaired).',
    request: '{ action, method:string, params?:object }',
    response: '{ result:object } | { error:{code,data:{code}} } | { success:false }',
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
  [ACTIONS.dexiePost]: {
    summary: "dexie marketplace (#102): POST this wallet's already-built offer bytes to api.dexie.space so other wallets can discover it. No wallet key involved — a plain upload of bytes `makeOffer` already produced.",
    request: '{ action, offer:string /* offer1… */ }',
    response: "{ dexieId:string, known:boolean } | { success:false, code:'DEXIE_POST_FAILED', message }",
  },
  [ACTIONS.dexieBrowse]: {
    summary: 'dexie marketplace (#102): browse currently-open offers on api.dexie.space, optionally filtered by offered/requested asset. Never throws — a flaky dexie read returns an empty list.',
    request: '{ action, offered?:string, requested?:string }',
    response: "{ offers:[{ id, offerStr, status:number, dateFound, offered:[{id,code,name,amount}], requested:[{id,code,name,amount}] }] }",
  },
  [ACTIONS.dexieResolve]: {
    summary: 'dexie marketplace (#102): resolve a dexie.space offer link/id to its `offer1…` bytes, for the Take flow to inspect via the SAME path as a pasted offer (dexie\'s own decoded fields are never trusted for the actual take).',
    request: '{ action, idOrUrl:string }',
    response: '{ offer:{ id, offerStr, status, dateFound, offered, requested } | null }',
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
  [ACTIONS.openExtensionPage]: {
    summary: 'Open a full-page extension surface (an app.html deep-link) in a new tab — used by the #292 injected page toolbar.',
    request: '{ action, page:string /* app.html#wallet | app.html#network/shield | app.html#network/control */ }',
    response: '{ success:boolean, error?:string }',
  },
  [ACTIONS.getToolbarShortcut]: {
    summary:
      "Toolbar hide + keyboard show/hide (#366): resolve the ACTUAL bound `chrome.commands` shortcut for `toggle-dig-toolbar` via `chrome.commands.getAll()` (an extension-page-only API a content script cannot call itself). `shortcut` is the empty string when the command exists but has no key currently bound (the user cleared it at chrome://extensions/shortcuts) — the caller falls back to the manifest default (`toolbarShortcutHint`).",
    request: '{ action }',
    response: '{ shortcut:string }',
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
