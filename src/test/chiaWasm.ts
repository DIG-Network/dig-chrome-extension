/**
 * Test-only loader for `chia-wallet-sdk-wasm` under Node/Vitest. The published package is a
 * wasm-bindgen BUNDLER target (`import * as wasm from "*_bg.wasm"`), which the jsdom test env can't
 * instantiate. So we import the `_bg.js` glue (which has NO `.wasm` import) and hand it a freshly
 * WebAssembly-instantiated module whose sole import is that same glue — the proven pattern from
 * hub.dig.net's wallet-emulator `loadWasms`. Used to inject a real wasm into the pure derivation
 * module for the golden parity test. (Excluded from coverage: it is a test harness, not app code.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChiaWasm } from '@/lib/keystore/derive';

let cached: Promise<ChiaWasm> | null = null;

export function loadChiaWasmNode(): Promise<ChiaWasm> {
  if (cached) return cached;
  cached = (async () => {
    const glue = await import('chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.js');
    const wasmBytes = new Uint8Array(
      readFileSync(resolve(process.cwd(), 'node_modules/chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.wasm')),
    );
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      './chia_wallet_sdk_wasm_bg.js': glue as unknown as WebAssembly.ModuleImports,
    });
    glue.__wbg_set_wasm(instance.exports);
    const start = (instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start;
    if (start) start();
    return glue as unknown as ChiaWasm;
  })();
  return cached;
}
