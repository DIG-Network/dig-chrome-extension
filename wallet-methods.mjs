/**
 * CHIP-0002 / Chia wallet method surface for the injected `window.chia` provider.
 *
 * This is a THIN RE-EXPORT of the canonical `@dignetwork/chia-provider` package — the single
 * source of truth for the DIG `window.chia` contract, shared byte-for-byte with the native DIG
 * Browser. The method catalogue, alias table, param remap, and state-changing set all live in the
 * package so the extension and the browser can never drift (the old per-consumer duplication
 * caused exactly that drift — e.g. one consumer mishandling a 202 pending). See the package
 * SPEC.md for the normative contract.
 *
 * Namespacing rules (implemented in the package's `normalizeMethod`):
 *   - `chip0002_*` and `chia_*` methods pass through as-is.
 *   - a Goby/Sage alias (`transfer`, `createOffer`, `getNFTs`, …) → its broker name.
 *   - any other bare name (e.g. "getPublicKeys") is namespaced to `chip0002_<name>`.
 *
 * Re-exported here so the background SW, wallet-broker, wallet-wc, agent-surface, and the tests
 * keep importing `./wallet-methods.mjs` unchanged.
 */
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
