/**
 * Shared `KeystoreWasm` test double standing in for `@dignetwork/dig-keystore-wasm`
 * (dig_ecosystem #147 Phase B). `src/lib/keystore/digwx1.ts` never imports the real wasm binding
 * directly (see its module doc — the real module is loaded only at the offscreen-document runtime
 * edge, `src/entries/offscreen.ts`), so every V2 unit test across this repo (`digwx1.test.ts`,
 * `vault.test.ts`) injects one of these instead of loading the real wasm in Vitest/jsdom.
 *
 * It's a minimal in-memory AEAD stand-in (NOT real Argon2id/AES-GCM) — good enough to exercise the
 * vault's own V2 wiring (record shape, version dispatch, error propagation on a wrong password).
 * The REAL crypto is proven by dig-keystore's own `wasm-bindgen-test` suite
 * (`wasm/tests/opaque_wasm.rs`) and this repo's Playwright e2e against the built extension.
 */
import type { KeystoreWasm } from '@/lib/keystore/digwx1';

export function makeFakeKeystoreWasm(): KeystoreWasm {
  // A trivial "tag" (sum of the password bytes, mod 256) stands in for AEAD authentication — wrong
  // password -> wrong tag -> `open` throws, matching the real binding's fail-closed contract.
  const pwTag = (password: string): number => {
    const pw = new TextEncoder().encode(password);
    let sum = 0;
    for (const b of pw) sum = (sum + b) & 0xff;
    return sum;
  };
  const seal =
    (marker: string) =>
    (password: string, secret: Uint8Array): Uint8Array => {
      const pw = new TextEncoder().encode(password);
      const out = new Uint8Array(secret.length + 2);
      out[0] = marker.charCodeAt(0);
      out[1] = pwTag(password);
      for (let i = 0; i < secret.length; i++) out[i + 2] = secret[i] ^ pw[i % pw.length] ^ 0xa5;
      return out;
    };
  return {
    seal: seal('D'),
    sealStrong: seal('S'),
    open(password: string, blob: Uint8Array): Uint8Array {
      if (blob.length < 2) throw new Error('DecryptFailed: malformed blob');
      if (blob[1] !== pwTag(password)) throw new Error('DecryptFailed: wrong password');
      const pw = new TextEncoder().encode(password);
      const out = new Uint8Array(blob.length - 2);
      for (let i = 0; i < out.length; i++) out[i] = blob[i + 2] ^ pw[i % pw.length] ^ 0xa5;
      return out;
    },
  };
}
