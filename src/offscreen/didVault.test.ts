import { describe, it, expect, beforeAll } from 'vitest';
import { Vault } from '@/offscreen/vault';
import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from '@/offscreen/chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * DID management (#93) through the REAL vault path — `Vault.handle` for `listDids` / `prepareDidCreate`
 * / `prepareDidTransfer` against the wasm Simulator + a fake chain (deterministic "sim coinset" in CI).
 * The create/transfer summaries are decoded FROM the built spend, so asserting them proves the vault
 * built a correct, self-owned DID op; the held pending id is broadcastable via the shared `confirmSend`
 * path. `pushSpendBundle` is a no-op here because the vault signs with the MAINNET AGG_SIG_ME genesis
 * (production-correct) which the testnet11 Simulator cannot validate — the consensus-valid,
 * Simulator-accepted DID create/transfer (testnet11-signed) is proven in dids.test.ts. Never broadcasts
 * a real spend.
 */

interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm {
  Simulator: new () => SimHandle;
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
}

let chia: TestWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

function simChain(sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinRecords: async () => [],
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    // No-op push: the vault signs mainnet AGG_SIG_ME, which the testnet sim can't validate (see header).
    pushSpendBundle: async () => ({ success: true }),
    coinConfirmed: async () => true,
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
  };
}

async function unlockedVault(): Promise<{ vault: Vault; seed: Uint8Array }> {
  const vault = new Vault();
  await vault.handle({ op: 'importWallet', mnemonic: golden.mnemonic, password: 'did-mgmt-test' });
  return { vault, seed: await mnemonicToSeed(golden.mnemonic) };
}

describe('Vault DID management (#93)', () => {
  it('prepareDidCreate builds a DID held under a pending id, with a decode-from-spend summary', async () => {
    const { vault, seed } = await unlockedVault();
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const chain = simChain(sim);

    const res = await vault.handle({ op: 'prepareDidCreate', activeIndex: 0 }, { chia: chia as never, chain });
    expect(res.success).toBe(true);
    expect(res.pendingId).toBeTruthy();
    expect(res.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.didCreateSummary?.p2PuzzleHashHex).toBe(ring[0].puzzleHashHex);

    // The pending entry exists → confirmSend reaches the broadcast path (not NO_PENDING) and signs+pushes.
    const conf = await vault.handle({ op: 'confirmSend', pendingId: res.pendingId }, { chia: chia as never, chain });
    expect(conf.code).not.toBe('NO_PENDING');
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();
  });

  it('prepareDidCreate fails NO_XCH_COINS when the wallet has no coins (before any pending id is held)', async () => {
    const { vault } = await unlockedVault();
    const res = await vault.handle({ op: 'prepareDidCreate' }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(res.success).toBe(false);
    // #179 regression: `handle()`'s catch used to collapse every domain throw (dids.ts's
    // `NO_XCH_COINS`/`NO_SUITABLE_COIN` "CODE: message" convention) to a generic `VAULT_ERROR`,
    // hiding the real cause from the UI. The specific code must survive to the caller.
    expect(res.code).toBe('NO_XCH_COINS');
    expect(res.message).toMatch(/NO_XCH_COINS/);
  });

  it('prepareDidCreate fails NO_SUITABLE_COIN when even combining every coin the total is short of the DID amount plus fee (#179)', async () => {
    const { vault, seed } = await unlockedVault();
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 100n);
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 100n);
    const chain = simChain(sim);
    const res = await vault.handle({ op: 'prepareDidCreate', fee: '1000000', activeIndex: 0 }, { chia: chia as never, chain });
    expect(res.success).toBe(false);
    expect(res.code).toBe('NO_SUITABLE_COIN');
  });

  it('prepareDidCreate fails LOCKED when the wallet holds no key', async () => {
    const vault = new Vault();
    const res = await vault.handle({ op: 'prepareDidCreate' }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(res.success).toBe(false);
    expect(res.code).toBe('LOCKED');
  });

  it('listDids returns the wallet DIDs (empty when none held)', async () => {
    const { vault, seed } = await unlockedVault();
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    const res = await vault.handle({ op: 'listDids', activeIndex: 0 }, { chia: chia as never, chain: simChain(sim) });
    expect(res.success).toBe(true);
    expect(res.dids).toEqual([]);
  });

  it('listDids fails LOCKED when the wallet holds no key', async () => {
    const vault = new Vault();
    const res = await vault.handle({ op: 'listDids' }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(res.success).toBe(false);
    expect(res.code).toBe('LOCKED');
  });

  it('prepareDidTransfer fails DID_NOT_FOUND when the wallet does not hold the DID (BAD_REQUEST guard before that: missing fields)', async () => {
    const { vault } = await unlockedVault();
    const missing = await vault.handle({ op: 'prepareDidTransfer' }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(missing.success).toBe(false);
    expect(missing.code).toBe('BAD_REQUEST');
  });

  it('confirmDidCreate/confirmDidTransfer reuse confirmSend and hit NO_PENDING for a bogus id', async () => {
    const { vault } = await unlockedVault();
    const res = await vault.handle({ op: 'confirmSend', pendingId: 'does-not-exist' }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(res.success).toBe(false);
    expect(res.code).toBe('NO_PENDING');
  });
});
