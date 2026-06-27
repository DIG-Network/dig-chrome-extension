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
 * Normalise a method name to its canonical namespaced form, exactly as the provider
 * does before sending to the broker:
 *   - "connect" / "chip0002_connect" → "chip0002_connect"
 *   - "getPublicKeys" → "chip0002_getPublicKeys"
 *   - "chia_getAddress" → "chia_getAddress" (unchanged)
 * @param {string} method
 * @returns {string}
 */
export function normalizeMethod(method) {
  if (!method) return method;
  if (/^(chip0002_|chia_)/.test(method)) return method;
  return 'chip0002_' + method;
}

/** True if the (normalised) method is part of the supported wallet surface. */
export function isSupportedMethod(method) {
  return WALLET_METHODS.includes(normalizeMethod(method));
}

/** True if the (normalised) method needs an explicit per-call wallet approval. */
export function isStateChanging(method) {
  return STATE_CHANGING_METHODS.has(normalizeMethod(method));
}
