/**
 * Chain read client for the self-custody balance scan (§4.3). A tiny interface over the coinset
 * JSON-RPC `get_coin_records_by_puzzle_hashes` so the pure scan logic (`scan.ts`) is testable with a
 * fake, while production wraps the wasm `RpcClient` (which fetches coinset.org from the offscreen
 * document — extensions bypass CORS; `coinset.org` is in host_permissions + connect-src).
 */

import type { ChiaWasm } from '@/lib/keystore/derive';

/** The minimal chain-read surface the balance scan needs. */
export interface ChainClient {
  /** Total UNSPENT coin amount (base units) across ALL the given puzzle hashes (hex, no `0x`). */
  totalUnspent(puzzleHashesHex: string[]): Promise<number>;
}

/** The default public coinset gateway (extensions bypass its CORS). */
export const DEFAULT_COINSET_URL = 'https://api.coinset.org';
/** Coinset caps a puzzle-hash batch; scan in chunks to stay under it. */
export const COINSET_BATCH = 300;

/* c8 ignore start — production wasm RpcClient adapter: instantiated only in the offscreen document
   at runtime (it fetches coinset.org). The pure scan logic that consumes this is unit-tested with a
   fake ChainClient; the wasm client itself is exercised end-to-end, not in the jsdom harness. */

/** The wasm coinset RpcClient surface this adapter uses. */
interface WasmRpcClient {
  getCoinRecordsByPuzzleHashes(
    puzzleHashes: Uint8Array[],
    startHeight: number | undefined,
    endHeight: number | undefined,
    includeSpentCoins: boolean | undefined,
  ): Promise<{ success: boolean; error?: string; coinRecords?: Array<{ coin: { amount: bigint } }> }>;
}
export interface RpcCapableWasm extends ChiaWasm {
  fromHex(value: string): Uint8Array;
  RpcClient: { new (coinsetUrl: string): WasmRpcClient };
}

/**
 * Build a {@link ChainClient} backed by the wasm coinset `RpcClient`. Batches the query, requests
 * UNSPENT coins only, and sums their amounts. (Summing `Number(amount)` is exact for realistic
 * personal balances < ~9000 XCH; larger balances would exceed `Number` precision — a known v1 limit.)
 */
export function makeWasmChainClient(chia: RpcCapableWasm, coinsetUrl: string = DEFAULT_COINSET_URL): ChainClient {
  const rpc = new chia.RpcClient(coinsetUrl);
  return {
    async totalUnspent(puzzleHashesHex) {
      let total = 0;
      for (let i = 0; i < puzzleHashesHex.length; i += COINSET_BATCH) {
        const phBytes = puzzleHashesHex.slice(i, i + COINSET_BATCH).map((h) => chia.fromHex(h));
        const res = await rpc.getCoinRecordsByPuzzleHashes(phBytes, undefined, undefined, false);
        if (!res.success) throw new Error(res.error || 'coinset query failed');
        total += (res.coinRecords ?? []).reduce((s, r) => s + Number(r.coin.amount), 0);
      }
      return total;
    },
  };
}
/* c8 ignore stop */
