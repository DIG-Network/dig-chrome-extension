/**
 * CHIP-0002 / Chia wallet method surface for the injected `window.chia` provider.
 *
 * This mirrors the native DIG Browser's dig-wallet method set (SYSTEM.md →
 * "dig-wallet dapp/WC method surface") so a dapp gets the SAME `window.chia` whether
 * the user is on the native DIG Browser or on Chrome/Edge/Brave/Firefox with this
 * extension. The extension can't run an in-process wallet, so these are brokered over
 * WalletConnect to Sage — but the method names + namespacing a dapp sees are identical.
 *
 * Namespacing rules (also enforced in dig-provider.js):
 *   - `chip0002_*` and `chia_*` methods pass through as-is.
 *   - a bare name (e.g. "getPublicKeys") is namespaced to `chip0002_<name>`.
 *
 * This is an ES module so it can be unit-tested and imported by the background SW.
 */

/** CHIP-0002 core methods (asset-generic; any CAT by assetId). */
export const CHIP0002_METHODS = [
  'chip0002_chainId',
  'chip0002_connect',
  'chip0002_getPublicKeys',
  'chip0002_filterUnlockedCoins',
  'chip0002_signMessage',
  'chip0002_signCoinSpends',
  'chip0002_getAssetBalance',
  'chip0002_getAssetCoins',
];

/** chia_* methods (addresses, sends, NFTs, DIDs, offers). */
export const CHIA_METHODS = [
  'chia_getAddress',
  'chia_signMessageByAddress',
  'chia_send',
  'chia_getTransactions',
  'chia_getNfts',
  'chia_transferNft',
  'chia_mintNft',
  'chia_bulkMintNfts',
  'chia_getDids',
  'chia_createDidWallet',
  'chia_transferDid',
  'chia_getOfferSummary',
  'chia_createOffer',
  'chia_takeOffer',
  'chia_cancelOffer',
];

/** The full Sage-parity method surface a dapp can call through `window.chia`. */
export const WALLET_METHODS = [...CHIP0002_METHODS, ...CHIA_METHODS];

/**
 * Methods that mutate on-chain / wallet state. These require an explicit per-call
 * approval in the wallet (Sage), in addition to the per-origin connect consent. Read
 * methods (chainId, getPublicKeys, getAddress, balances, summaries) do not.
 */
export const STATE_CHANGING_METHODS = new Set([
  'chip0002_signMessage',
  'chip0002_signCoinSpends',
  'chia_signMessageByAddress',
  'chia_send',
  'chia_transferNft',
  'chia_mintNft',
  'chia_bulkMintNfts',
  'chia_createDidWallet',
  'chia_transferDid',
  'chia_createOffer',
  'chia_takeOffer',
  'chia_cancelOffer',
]);

/**
 * Goby / CHIP-0002 / Sage-WalletConnect2 method-name aliases.
 *
 * dApps built for Goby (dexie.space, tibetswap, …) or Sage's WC2 API call BARE
 * method names that do NOT map 1:1 to `chip0002_<name>` — Goby's `transfer` is
 * Sage's `chia_send`; `createOffer`/`takeOffer`/`cancelOffer`/`getNFTs` live in the
 * `chia_*` namespace, not `chip0002_*`. This table routes each dApp-facing name to
 * the DIG broker method that actually serves it, so the same `window.chia` a Goby
 * dApp expects (see the loroco goby-provider surface) works against DIG's Sage
 * broker. Names NOT listed here fall back to `chip0002_<name>` namespacing.
 *
 * Kept byte-aligned with the two injected providers (dig-provider.js IIFE and the
 * native DIG Browser dig_provider.js) — SYSTEM.md → keep the providers in sync.
 * @readonly
 */
export const GOBY_ALIASES = Object.freeze({
  // CHIP-0002 core (read + sign) → chip0002_
  chainId: 'chip0002_chainId',
  getPublicKeys: 'chip0002_getPublicKeys',
  filterUnlockedCoins: 'chip0002_filterUnlockedCoins',
  getAssetBalance: 'chip0002_getAssetBalance',
  getAssetCoins: 'chip0002_getAssetCoins',
  signMessage: 'chip0002_signMessage',
  signCoinSpends: 'chip0002_signCoinSpends',
  // Goby extensions + Sage WC2 → chia_
  transfer: 'chia_send',
  send: 'chia_send',
  getAddress: 'chia_getAddress',
  signMessageByAddress: 'chia_signMessageByAddress',
  getTransactions: 'chia_getTransactions',
  getNFTs: 'chia_getNfts',
  getNfts: 'chia_getNfts',
  transferNft: 'chia_transferNft',
  mintNft: 'chia_mintNft',
  bulkMintNfts: 'chia_bulkMintNfts',
  getDids: 'chia_getDids',
  createDid: 'chia_createDidWallet',
  createDidWallet: 'chia_createDidWallet',
  transferDid: 'chia_transferDid',
  getOfferSummary: 'chia_getOfferSummary',
  createOffer: 'chia_createOffer',
  takeOffer: 'chia_takeOffer',
  cancelOffer: 'chia_cancelOffer',
});

/**
 * Normalise a method name to its canonical namespaced (broker) form, exactly as the
 * provider does before sending to the broker:
 *   - already-namespaced (`chip0002_*` / `chia_*`) → unchanged
 *   - a Goby/Sage alias (`transfer`, `createOffer`, `getNFTs`, …) → its broker name
 *     via GOBY_ALIASES (`chia_send`, `chia_createOffer`, `chia_getNfts`)
 *   - any other bare name (`getPublicKeys`, `signCoinSpends`, `somethingNew`) →
 *     `chip0002_<name>`
 * @param {string} method
 * @returns {string}
 */
export function normalizeMethod(method) {
  if (!method) return method;
  if (/^(chip0002_|chia_)/.test(method)) return method;
  if (GOBY_ALIASES[method]) return GOBY_ALIASES[method];
  return 'chip0002_' + method;
}

/**
 * Remap a Goby/Sage dApp's params to the shape DIG's broker method expects.
 *
 * Goby's `transfer` names the recipient `to`; Sage's `chia_send` names it `address`.
 * When a dApp calls `transfer({to, amount, …})` we hand the broker
 * `chia_send({address, amount, …})`. An explicit `address` is respected (never
 * overwritten). All other methods pass their params through unchanged.
 * @param {string} method  the dApp-facing method name (pre-normalisation)
 * @param {object|undefined} params
 * @returns {object|undefined}
 */
export function remapGobyParams(method, params) {
  if (!params) return params;
  if ((method === 'transfer' || method === 'send') && params.to != null && params.address == null) {
    const { to, ...rest } = params;
    return { ...rest, address: to };
  }
  return params;
}

/** True if the (normalised) method is part of the supported wallet surface. */
export function isSupportedMethod(method) {
  return WALLET_METHODS.includes(normalizeMethod(method));
}

/** True if the (normalised) method needs an explicit per-call wallet approval. */
export function isStateChanging(method) {
  return STATE_CHANGING_METHODS.has(normalizeMethod(method));
}
