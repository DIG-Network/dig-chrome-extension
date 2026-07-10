/**
 * The wasm-bindgen "bundler" glue subpath has no shipped types. It is imported ONLY by the Node
 * test loader (`src/test/chip35Wasm.ts`, #228) to hand-instantiate the wasm; production code
 * imports the typed main entry (`@dignetwork/chip35-dl-coin-wasm`). Declared here so `tsc` resolves
 * the subpath — mirrors `chia-wasm-bg.d.ts`'s identical rationale for `chia-wallet-sdk-wasm`.
 */
declare module '@dignetwork/chip35-dl-coin-wasm/chip35_dl_coin_wasm_bg.js' {
  export function __wbg_set_wasm(exports: unknown): void;
}
