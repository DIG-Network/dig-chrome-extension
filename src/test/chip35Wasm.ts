/**
 * Test-only loader for `@dignetwork/chip35-dl-coin-wasm` under Node/Vitest (#228). Same wasm-bindgen
 * BUNDLER-target shape as `chia-wallet-sdk-wasm` (`import * as wasm from "*_bg.wasm"`), which jsdom
 * can't instantiate directly — mirrors `chiaWasm.ts`'s proven glue-plus-manual-instantiate pattern:
 * import the `_bg.js` glue (no `.wasm` import) and hand it a freshly WebAssembly-instantiated module
 * whose sole import is that same glue. Used by `anchoredRoot.test.ts` to run the #228 chain walk
 * against the REAL wasm parser (not a hand-rolled fake) over a captured real-mainnet fixture.
 * (Excluded from coverage: it is a test harness, not app code.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Chip35Wasm } from '@/offscreen/anchoredRoot';

let cached: Promise<Chip35Wasm> | null = null;

export function loadChip35WasmNode(): Promise<Chip35Wasm> {
  if (cached) return cached;
  cached = (async () => {
    const glue = await import('@dignetwork/chip35-dl-coin-wasm/chip35_dl_coin_wasm_bg.js');
    const wasmBytes = new Uint8Array(
      readFileSync(resolve(process.cwd(), 'node_modules/@dignetwork/chip35-dl-coin-wasm/chip35_dl_coin_wasm_bg.wasm')),
    );
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      './chip35_dl_coin_wasm_bg.js': glue as unknown as WebAssembly.ModuleImports,
    });
    glue.__wbg_set_wasm(instance.exports);
    const start = (instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start;
    if (start) start();
    return glue as unknown as Chip35Wasm;
  })();
  return cached;
}
