import { describe, it, expect, beforeAll } from 'vitest';
import { prepareNftDidAssign, type AssignWasm } from './didAssign';
import { prepareNftMint, listNfts, type NftWasm } from './nfts';
import { prepareDidCreate, type DidWasm } from './dids';
import { buildKeyring, signAndBundle, type SendFlowWasm } from './sendFlow';
import { TESTNET11_AGG_SIG_ME } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * NFT↔DID ownership assignment, proven authoritatively against the wasm Simulator: mint an NFT +
 * create a DID for the SAME seed-derived wallet, `prepareNftDidAssign` builds the CHIP-0011
 * ownership-bonding spend (byte-identical to chia-sdk-driver's `Nft::assign_owner` +
 * `UpdateNftAction` — verified against xch-dev/chia-wallet-sdk source, since chia-wallet-sdk-wasm
 * 0.33 exposes no `Spends.addDid`/`Action` helper for this), and after the Simulator accepts the
 * bundle `listNfts` reports the NFT's `collectionId` as the DID's launcher id. Read-only in CI (never
 * broadcasts to mainnet); signs with the testnet11 genesis so the Simulator validates it.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends AssignWasm {
  Simulator: new () => SimHandle;
  NftMetadata: new (
    editionNumber: bigint,
    editionTotal: bigint,
    dataUris: string[],
    dataHash: Uint8Array | undefined,
    metadataUris: string[],
    metadataHash: Uint8Array | undefined,
    licenseUris: string[],
    licenseHash?: Uint8Array,
  ) => unknown;
  Constants: { nftMetadataUpdaterDefaultHash(): Uint8Array };
}

let chia: TestWasm;
const asAssign = () => chia as unknown as AssignWasm;
const asNft = () => chia as unknown as NftWasm;
const asDid = () => chia as unknown as DidWasm;
const asFlow = () => chia as unknown as SendFlowWasm;

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

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
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
  };
}

describe('didAssign — assign a wallet-owned DID as an NFT owner (Simulator-validated, #93)', () => {
  it('assigns an owned DID as an owned NFT owner; listNfts reports the DID as collectionId', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 2_000_000_000_000n);
    const chain = simChain(sim);

    const minted = await prepareNftMint(asNft(), chain, { seed, activeIndex: 0, dataUris: ['https://example.com/1.png'] });
    const mintBundle = signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(mintBundle)).success).toBe(true);

    const did = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    const didBundle = signAndBundle(asFlow(), did.coinSpends, did.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(didBundle)).success).toBe(true);

    // Before assignment: no owner.
    const before = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(before[0].collectionId).toBeNull();

    const prepared = await prepareNftDidAssign(asAssign(), chain, {
      seed,
      nftLauncherId: minted.launcherId,
      didLauncherId: did.launcherId,
      activeIndex: 0,
    });
    expect(prepared.summary.nftLauncherId).toBe(minted.launcherId);
    expect(prepared.summary.didLauncherId).toBe(did.launcherId);
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    const after = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(after).toHaveLength(1);
    expect(after[0].launcherId).toBe(minted.launcherId);
    expect(after[0].collectionId).toBe(did.launcherId);
    // The DID itself is unaffected (still owned by the same wallet, same launcher id).
    expect(after[0].p2PuzzleHash).toBe(ring[0].puzzleHashHex);
  });

  it('pays a fee from a separate coin when assigning', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 2_000_000_000_000n);
    const chain = simChain(sim);

    const minted = await prepareNftMint(asNft(), chain, { seed, activeIndex: 0, dataUris: ['https://example.com/1.png'] });
    expect((await chain.pushSpendBundle(signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME))).success).toBe(true);
    const did = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    expect((await chain.pushSpendBundle(signAndBundle(asFlow(), did.coinSpends, did.secretKeys, TESTNET11_AGG_SIG_ME))).success).toBe(true);

    const prepared = await prepareNftDidAssign(asAssign(), chain, {
      seed,
      nftLauncherId: minted.launcherId,
      didLauncherId: did.launcherId,
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    expect((await chain.pushSpendBundle(signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME))).success).toBe(true);
  });

  it('throws NFT_NOT_FOUND when the wallet does not hold the NFT', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 2_000_000_000_000n);
    const chain = simChain(sim);
    const did = await prepareDidCreate(asDid(), chain, { seed, activeIndex: 0 });
    expect((await chain.pushSpendBundle(signAndBundle(asFlow(), did.coinSpends, did.secretKeys, TESTNET11_AGG_SIG_ME))).success).toBe(true);

    await expect(
      prepareNftDidAssign(asAssign(), chain, { seed, nftLauncherId: 'ab'.repeat(32), didLauncherId: did.launcherId, activeIndex: 0 }),
    ).rejects.toThrow(/NFT_NOT_FOUND/);
  });

  it('throws DID_NOT_FOUND when the wallet does not hold the DID', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 2_000_000_000_000n);
    const chain = simChain(sim);
    const minted = await prepareNftMint(asNft(), chain, { seed, activeIndex: 0, dataUris: ['https://example.com/1.png'] });
    expect((await chain.pushSpendBundle(signAndBundle(asFlow(), minted.coinSpends, minted.secretKeys, TESTNET11_AGG_SIG_ME))).success).toBe(true);

    await expect(
      prepareNftDidAssign(asAssign(), chain, { seed, nftLauncherId: minted.launcherId, didLauncherId: 'ab'.repeat(32), activeIndex: 0 }),
    ).rejects.toThrow(/DID_NOT_FOUND/);
  });
});
