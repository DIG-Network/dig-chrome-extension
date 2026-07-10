/* @ts-self-types="./dig_keystore_wasm.d.ts" */
import * as wasm from "./dig_keystore_wasm_bg.wasm";
import { __wbg_set_wasm } from "./dig_keystore_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    init, open, seal, sealStrong, sealWithSeed, verifyPassword
} from "./dig_keystore_wasm_bg.js";
