/**
 * Testable core of the injected `window.chia` provider.
 *
 * This is a THIN RE-EXPORT of the canonical `@dignetwork/chia-provider` package — the single
 * source of truth for the DIG `window.chia` contract, shared byte-for-byte with the native DIG
 * Browser so the two injected providers can never drift. `buildProvider({ bridgeCall, version })`
 * returns the provider object from an injected transport; the extension supplies a postMessage
 * bridge (dig-provider.entry.mjs, bundled into dist/dig-provider.js), tests supply a fake one.
 *
 * Re-exported here so agent-surface.mjs and the provider tests keep importing
 * `./dig-provider-core.mjs` unchanged. The PROVIDER_INFO the package ships is the EXTENSION
 * edition (transport:'injected', edition:'extension') — the value this consumer needs.
 * See the package SPEC.md for the normative contract.
 */
export {
  WALLET_PROVIDER_VERSION,
  WALLET_PROVIDER_NAME,
  WALLET_API_VERSION,
  WALLET_CHAIN_ID,
  PROVIDER_INFO,
  PROVIDER_ERROR_CODES,
  mapEnvelopeToError,
  buildProvider,
} from '@dignetwork/chia-provider';
