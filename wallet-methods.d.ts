// Type declarations for wallet-methods.mjs — a thin re-export of the canonical
// @dignetwork/chia-provider package (the CHIP-0002 / chia_* wallet method surface, shared
// byte-for-byte with the native DIG Browser). Re-export the package types so this file can
// never drift from the runtime contract.

export {
  CHIP0002_METHODS,
  CHIA_METHODS,
  WALLET_METHODS,
  STATE_CHANGING_METHODS,
  GOBY_ALIASES,
  normalizeMethod,
  remapGobyParams,
  isSupportedMethod,
  isStateChanging,
} from '@dignetwork/chia-provider';
