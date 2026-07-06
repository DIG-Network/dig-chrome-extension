import { describe, it, expect, beforeAll } from 'vitest';
import { Vault } from '@/offscreen/vault';
import { prepareSendVaultRequest } from '@/lib/custody-session';
import { buildKeyring, signAndBundle, type SendFlowWasm } from '@/offscreen/sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from '@/offscreen/signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from '@/offscreen/chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * Money-critical regression #121 — CAT vs native-XCH ROUTING through the REAL stack.
 *
 * This drives the actual pieces that shipped the bug together: the SW→vault mapping
 * (`prepareSendVaultRequest`, which dropped `assetId`) → the real `Vault.handle('prepareSend')`
 * routing (`isCat = !!req.assetId`) → the real CAT/XCH spend builders — all against the wasm
 * Simulator (deterministic "sim coinset" in CI, no network). If the mapping drops `assetId` again,
 * a requested CAT send builds a native XCH send and `summary.asset` comes back `'XCH'` — this test
 * fails. It is the end-to-end counterpart to the unit test in custody-session.test.ts.
 */

interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm {
  fromHex(h: string): Uint8Array;
  toHex(b: Uint8Array): string;
  Address: new (puzzleHash: Uint8Array, prefix: string) => { encode(): string };
  Simulator: new () => SimHandle;
  Clvm: new () => {
    delegatedSpend(conditions: unknown[]): unknown;
    standardSpend(pk: unknown, spend: unknown): unknown;
    coinSpends(): ChainCoinSpend[];
  };
  Spends: new (clvm: unknown, changePh: Uint8Array) => {
    addXch(coin: unknown): void;
    apply(actions: unknown[]): unknown;
    prepare(deltas: unknown): { pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; conditions(): unknown[] }>; insert(id: Uint8Array, s: unknown): void; spend(): { cats(): unknown[]; cat(id: unknown): Array<{ info: { assetId: Uint8Array } }> } };
  };
  Action: { singleIssueCat(hidden: undefined, amount: bigint): unknown };
  SpendBundle: new (cs: unknown, s: unknown) => ChainSpendBundle;
}

let chia: TestWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed ChainClient (reads coins/spends from the simulator; push validates via newTransaction). */
function simChain(sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinRecords: async () => [],
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    pushSpendBundle: async (bundle) => {
      sim.newTransaction(bundle);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
  };
}

/** Issue a single-issuance CAT to the seed-derived index-0 address, funded by XCH there. Returns its TAIL hex. */
async function mintCatToWallet(sim: SimHandle, seed: Uint8Array): Promise<string> {
  const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { count: 2 });
  const ph0 = ring[0].puzzleHashHex;
  const key0 = ring[0];
  sim.newCoin(chia.fromHex(ph0), 5_000_000_000_000n);
  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, chia.fromHex(ph0));
  spends.addXch(sim.unspentCoins(chia.fromHex(ph0), false)[0]);
  const finished = spends.prepare(spends.apply([chia.Action.singleIssueCat(undefined, 1000n)]));
  for (const ps of finished.pendingSpends()) {
    finished.insert(ps.coin().coinId(), clvm.standardSpend(key0.pk, clvm.delegatedSpend(ps.conditions())));
  }
  const outputs = finished.spend();
  const assetIdHex = chia
    .toHex((outputs.cat(outputs.cats()[0])[0] as { info: { assetId: Uint8Array } }).info.assetId)
    .replace(/^0x/i, '')
    .toLowerCase();
  const issueSpends = clvm.coinSpends();
  const issueSig = signCoinSpends(chia as unknown as SigningWasm, issueSpends, [key0.sk], TESTNET11_AGG_SIG_ME);
  sim.newTransaction(new chia.SpendBundle(issueSpends, issueSig));
  sim.createBlock();
  return assetIdHex;
}

describe('prepareSend routing (#121, Simulator-validated end-to-end)', () => {
  it('a CAT prepareSend message routes to a CAT spend (summary.asset === assetId), not native XCH', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const sim = new chia.Simulator();
    const assetIdHex = await mintCatToWallet(sim, seed);

    const vault = new Vault();
    const imported = await vault.handle({ op: 'importWallet', mnemonic: golden.mnemonic, password: 'test-password-121' });
    expect(imported.success).toBe(true);

    const chainDeps = { chia: chia as never, chain: simChain(sim) };
    const recipient = new chia.Address(new Uint8Array(32).fill(9), 'xch').encode();

    // The exact message the popup sends for a CAT send, through the exact SW→vault mapping.
    const catReq = prepareSendVaultRequest({ recipient, amount: '400', fee: '0', assetId: assetIdHex }, 'https://sim');
    const catRes = await vault.handle(catReq, chainDeps);
    expect(catRes.success).toBe(true);
    // The load-bearing assertion: the token routes as its own TAIL, never as native XCH.
    expect(catRes.summary?.asset).toBe(assetIdHex);
    expect(catRes.summary?.asset).not.toBe('XCH');

    // Control: an XCH message (no assetId) still routes to a native XCH send.
    const xchReq = prepareSendVaultRequest({ recipient, amount: '250000000000', fee: '0' }, 'https://sim');
    const xchRes = await vault.handle(xchReq, chainDeps);
    expect(xchRes.success).toBe(true);
    expect(xchRes.summary?.asset).toBe('XCH');
  });
});
