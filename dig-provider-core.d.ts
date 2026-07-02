// Type declarations for dig-provider-core.mjs — a thin re-export of the canonical
// @dignetwork/chia-provider package (the single source of truth for the injected window.chia
// provider surface, shared byte-for-byte with the native DIG Browser). Re-export the package
// types so this file can never drift from the runtime contract.

export {
  WALLET_PROVIDER_VERSION,
  WALLET_PROVIDER_NAME,
  WALLET_API_VERSION,
  WALLET_CHAIN_ID,
  PROVIDER_INFO,
  PROVIDER_ERROR_CODES,
  mapEnvelopeToError,
  buildProvider,
  type ProviderInfo,
  type ProviderError,
  type ProviderErrorCodes,
  type ChiaProvider,
  type BuildProviderDeps,
  type BridgeCall,
} from '@dignetwork/chia-provider';
