/**
 * The wasm-bindgen "bundler" glue subpath has no shipped types. It is imported ONLY by the Node
 * test loader (`src/test/chiaWasm.ts`) to hand-instantiate the wasm; production code imports the
 * typed main entry (`chia-wallet-sdk-wasm`). Declared here so `tsc` resolves the subpath.
 */
declare module 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.js' {
  export function __wbg_set_wasm(exports: unknown): void;
}
