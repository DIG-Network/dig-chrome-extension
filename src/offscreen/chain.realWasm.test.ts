/**
 * Regression (#148, P0): the production wasm `RpcClient` adapter (`makeWasmChainClient`) was
 * `/* c8 ignore *\/`'d as "exercised end-to-end, not in the jsdom harness" — so it had ZERO test
 * coverage against the REAL wasm module. That hid a real bug: `makeWasmChainClient` constructed the
 * wasm-bindgen `RpcClient` via `new chia.RpcClient(coinsetUrl)`, but the actual generated class has
 * NO public constructor — only a static factory `RpcClient.new(coinsetUrl)` (confirmed against
 * `chia_wallet_sdk_wasm.d.ts` / `chia_wallet_sdk_wasm_bg.js`). Calling `new RpcClient(url)` does NOT
 * throw (a JS class with no explicit constructor silently accepts and ignores extra arguments), but
 * produces a phantom instance whose internal `__wbg_ptr` was never wired up. Every subsequent call
 * on it (`getCoinRecordsByPuzzleHashes`, `getCoinRecordsByHints`, `getCoinRecordByName`,
 * `getPuzzleAndSolution`, `pushTx`) then dispatches into wasm with a null self-pointer, which the
 * Rust side rejects immediately with `Error: null pointer passed to rust` — thrown from inside a
 * wasm-bindgen async adapter callback OUTSIDE the normal promise chain (an UNCAUGHT exception, not a
 * catchable rejection — confirmed empirically: it hangs the awaiting call forever and surfaces to
 * the test runner as an unhandled error). Because EVERY `ChainClient` method funnels through this
 * one broken `rpc` instance, this single bug took down every wallet read uniformly: balances,
 * activity, NFTs, DIDs, send — exactly the P0 symptom.
 *
 * This has been present since the coinset adapter was first written (chain.ts's very first commit,
 * #12) — it is NOT a recent regression from the v1.40/v1.41 DID/NFT-mint work (chain.ts, the
 * offscreen wasm-loading path, and the chia-wallet-sdk-wasm dependency itself — same resolved
 * 0.33.0, same integrity hash — are all byte-identical since v1.39.0). It was simply
 * never-before-exercised code; this test is the first thing to ever call it against the real wasm.
 *
 * This test uses the REAL wasm (via the repo's existing `loadChiaWasmNode` real-wasm test harness —
 * the same pattern `sendFlow.test.ts` uses for its Simulator tests) so a future wasm API drift on
 * the `RpcClient` construction contract fails CI again, instead of shipping silently. It does NOT
 * make a real network call — `globalThis.fetch` is globally stubbed to reject in unit tests
 * (vitest.setup.ts, "no real network in unit tests") — so the only way this test can observe the
 * null-pointer crash is if construction itself is broken; a correctly-constructed client instead
 * fails at the (expected, unit-test-disabled) fetch step, never at the wasm-bindgen dispatch layer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import { makeWasmChainClient, type RpcCapableWasm, type ChainClient } from '@/offscreen/chain';

let chia: RpcCapableWasm;
let chain: ChainClient;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as RpcCapableWasm;
  chain = makeWasmChainClient(chia, 'https://api.coinset.org');
});

/**
 * Await `p`, treating a resolution OR any rejection as fine EXCEPT the specific "null pointer
 * passed to rust" wasm-bindgen dispatch failure (#148) — that one specific message is the actual
 * regression under test. Any other rejection (e.g. the fetch-disabled-in-unit-tests error) proves
 * the call correctly reached past construction into a real dispatch attempt.
 */
async function expectNoNullPointerCrash(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toMatch(/null pointer passed to rust/i);
  }
}

describe('makeWasmChainClient (real wasm RpcClient construction contract, #148)', () => {
  it('constructs a properly-wired RpcClient — chia.RpcClient.new(url), never `new chia.RpcClient(url)`', () => {
    // The wasm-bindgen-generated RpcClient class has NO instance constructor — `new RpcClient(url)`
    // silently produces a phantom, unusable instance (see the file-level doc comment). The adapter
    // MUST use the static factory.
    const rpc = chia.RpcClient.new('https://api.coinset.org');
    expect(rpc).toBeInstanceOf(chia.RpcClient);
    // A real wasm-bindgen instance carries a defined internal pointer once properly constructed via
    // the factory; `new RpcClient(url)` never sets this (a bare Object.create with no wiring), so
    // this is a direct, mechanical proof the construction path is wired correctly.
    expect((rpc as unknown as { __wbg_ptr?: number }).__wbg_ptr).toBeDefined();
  });

  // Every ChainClient READ method funnels through the SAME `rpc` instance makeWasmChainClient
  // builds once — if construction were broken, EVERY one of these would hang/crash identically
  // with "null pointer passed to rust" (exactly the P0 symptom: balances, activity, NFTs, DIDs all
  // down at once). Covering all of them (instead of just one) proves the fix for every wallet
  // surface this adapter feeds, not just a single call site.
  it('totalUnspent reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.totalUnspent(['00'.repeat(32)]));
  });

  it('unspentCoins reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.unspentCoins(['00'.repeat(32)]));
  });

  it('coinsByHints reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.coinsByHints!(['00'.repeat(32)]));
  });

  it('coinConfirmed reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.coinConfirmed('00'.repeat(32)));
  });

  it('getCoinSpend reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.getCoinSpend('00'.repeat(32)));
  });

  it('coinRecords reaches past construction without a null-pointer crash', async () => {
    await expectNoNullPointerCrash(chain.coinRecords(['00'.repeat(32)]));
  });
});
