import { describe, it, expect, beforeAll } from 'vitest';
import { Vault } from '@/offscreen/vault';
import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from '@/offscreen/chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';
import { makeFakeKeystoreWasm } from '@/test/keystoreWasmFake';

// dig_ecosystem #147 Phase B: importWallet (the V2 writer) needs a keystoreWasm dep.
const keystoreWasm = makeFakeKeystoreWasm();

/**
 * NFT minting (#92) through the REAL vault path — `Vault.handle` for `prepareNftMint` against the wasm
 * Simulator + a fake chain (deterministic "sim coinset" in CI). The mint summary is decoded FROM the
 * built spend, so asserting it proves the vault built a correct, self-owned mint; the held pending id is
 * broadcastable via the shared `confirmSend` path. `pushSpendBundle` is a no-op here because the vault
 * signs with the MAINNET AGG_SIG_ME genesis (production-correct) which the testnet11 Simulator cannot
 * validate — the consensus-valid, Simulator-accepted mint (testnet11-signed) is proven in nfts.test.ts.
 * Never broadcasts a real spend.
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
  await vault.handle({ op: 'importWallet', mnemonic: golden.mnemonic, password: 'nft-mint-test' }, { keystoreWasm });
  return { vault, seed: await mnemonicToSeed(golden.mnemonic) };
}

describe('Vault NFT minting (#92)', () => {
  it('prepareNftMint builds a mint held under a pending id, with a decode-from-spend summary', async () => {
    const { vault, seed } = await unlockedVault();
    const ring = buildKeyring(chia as unknown as SendFlowWasm, seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const chain = simChain(sim);

    const res = await vault.handle(
      {
        op: 'prepareNftMint',
        nftMint: { dataUris: ['https://example.test/img.png'], royaltyBasisPoints: 250, fee: '0' },
        activeIndex: 0,
      },
      { chia: chia as never, chain },
    );
    expect(res.success).toBe(true);
    expect(res.pendingId).toBeTruthy();
    expect(res.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.nftMintSummary?.royaltyBasisPoints).toBe(250);
    expect(res.nftMintSummary?.dataUris).toEqual(['https://example.test/img.png']);
    // Royalty defaults to the minter (index-0).
    expect(res.nftMintSummary?.royaltyPuzzleHashHex).toBe(ring[0].puzzleHashHex);

    // The pending entry exists → confirmSend reaches the broadcast path (not NO_PENDING) and signs+pushes.
    const conf = await vault.handle({ op: 'confirmSend', pendingId: res.pendingId }, { chia: chia as never, chain });
    expect(conf.code).not.toBe('NO_PENDING');
    expect(conf.success).toBe(true);
    expect(conf.spentCoinId).toBeTruthy();
  });

  it('prepareNftMint rejects a mint with no data URI (BAD_REQUEST — before any chain read)', async () => {
    const { vault } = await unlockedVault();
    const res = await vault.handle({ op: 'prepareNftMint', nftMint: { dataUris: [] } }, { chia: chia as never, chain: simChain(new chia.Simulator()) });
    expect(res.success).toBe(false);
    expect(res.code).toBe('BAD_REQUEST');
  });

  it('prepareNftMint fails LOCKED when the wallet holds no key', async () => {
    const vault = new Vault();
    const res = await vault.handle(
      { op: 'prepareNftMint', nftMint: { dataUris: ['https://example.test/img.png'] } },
      { chia: chia as never, chain: simChain(new chia.Simulator()) },
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe('LOCKED');
  });
});
