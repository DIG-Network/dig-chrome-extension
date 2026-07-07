import { describe, it, expect, beforeAll } from 'vitest';
import { listNfts, prepareNftTransfer, prepareNftMint, prepareNftBulkTransfer, prepareNftBulkBurn, NFT_BURN_PUZZLE_HASH, type NftWasm, type NftChain } from './nfts';
import { buildKeyring, signAndBundle, type SendFlowWasm } from './sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed, entropyToMnemonic } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * NFT engine, proven authoritatively against the wasm Simulator: an NFT is minted to a seed-derived
 * wallet, `listNfts` finds it, `prepareNftTransfer` builds a transfer to a DIFFERENT seed-derived
 * wallet, and after the Simulator accepts the signed bundle the NFT is gone from the sender and
 * discoverable by the recipient (proving both the transfer AND the recipient hint). Read-only in CI
 * (never broadcasts to mainnet); signs with the testnet11 genesis so the Simulator validates it.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends NftWasm {
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
  SpendBundle: new (coinSpends: unknown[], signature: unknown) => ChainSpendBundle;
}

// golden.mnemonic is the all-abandon vector; derive a DISTINCT recipient wallet from fixed entropy.
const RECIPIENT_MNEMONIC = entropyToMnemonic(new Uint8Array(32).fill(9));

let chia: TestWasm;
const asNft = () => chia as unknown as NftWasm;
const asFlow = () => chia as unknown as SendFlowWasm;
const asSig = () => chia as unknown as SigningWasm;
const hx = (b: Uint8Array) => chia.toHex(b).replace(/^0x/i, '').toLowerCase();

/** bech32m address for a keyring entry's inner puzzle hash (the keyring itself carries no address). */
function addressOf(puzzleHashHex: string): string {
  const AddressCtor = (chia as unknown as { Address: new (ph: Uint8Array, prefix: string) => { encode(): string } }).Address;
  return new AddressCtor(chia.fromHex(puzzleHashHex), 'xch').encode();
}

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed chain client covering every method the NFT engine calls (incl. hint discovery). */
function simChain(sim: SimHandle): NftChain {
  const base: ChainClient = {
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
  return base;
}

/** Mint a single NFT to a seed-derived wallet's index-0 address (owner + royalty = self). */
function mintNftTo(sim: SimHandle, ring0: ReturnType<typeof buildKeyring>[number]): string {
  const ph0 = chia.fromHex(ring0.puzzleHashHex);
  const clvm = new chia.Clvm() as unknown as {
    nftMetadata(v: unknown): unknown;
    standardSpend(pk: unknown, s: unknown): unknown;
    delegatedSpend(c: unknown[]): unknown;
    coinSpends(): unknown[];
  };
  const spends = new (chia as unknown as {
    Spends: new (
      c: unknown,
      ph: Uint8Array,
    ) => {
      addXch(c: unknown): void;
      apply(a: unknown[]): unknown;
      prepare(d: unknown): {
        pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; conditions(): unknown[] }>;
        insert(id: Uint8Array, s: unknown): void;
        spend(): { nfts(): unknown[]; nft(id: unknown): { info: { launcherId: Uint8Array } } };
      };
    };
  }).Spends(clvm, ph0);
  spends.addXch(sim.unspentCoins(ph0, false)[0]);
  const metadata = clvm.nftMetadata(
    new chia.NftMetadata(1n, 1n, ['https://example.test/img.png'], undefined, ['https://example.test/meta.json'], undefined, []),
  );
  const mintAction = (chia as unknown as {
    Action: { mintNft(c: unknown, m: unknown, u: Uint8Array, r: Uint8Array, bps: number, amt: bigint, parent?: unknown): unknown };
  }).Action.mintNft(clvm, metadata, chia.Constants.nftMetadataUpdaterDefaultHash(), ph0, 300, 1n, undefined);
  const fin = spends.prepare(spends.apply([mintAction]));
  for (const ps of fin.pendingSpends()) fin.insert(ps.coin().coinId(), clvm.standardSpend(ring0.pk, clvm.delegatedSpend(ps.conditions())));
  const outputs = fin.spend();
  const launcherId = hx(outputs.nft(outputs.nfts()[0]).info.launcherId);
  const coinSpends = clvm.coinSpends();
  const sig = signCoinSpends(asSig(), coinSpends as never, [ring0.sk], TESTNET11_AGG_SIG_ME);
  sim.newTransaction(new chia.SpendBundle(coinSpends, sig));
  sim.createBlock();
  return launcherId;
}

describe('nfts — mint, list, transfer (Simulator-validated)', () => {
  it('lists a minted NFT with its on-chain metadata', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const launcherId = mintNftTo(sim, ring[0]);
    const chain = simChain(sim);

    const nfts = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(nfts).toHaveLength(1);
    expect(nfts[0].launcherId).toBe(launcherId);
    expect(nfts[0].p2PuzzleHash).toBe(ring[0].puzzleHashHex);
    expect(nfts[0].royaltyBasisPoints).toBe(300);
    expect(nfts[0].dataUris).toEqual(['https://example.test/img.png']);
    expect(nfts[0].metadataUris).toEqual(['https://example.test/meta.json']);
    expect(nfts[0].editionNumber).toBe('1');
  });

  it('transfers an NFT to another wallet; it leaves the sender and lands at the recipient', async () => {
    const senderSeed = await mnemonicToSeed(golden.mnemonic);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const senderRing = buildKeyring(asFlow(), senderSeed, { index: 0 });
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });
    const recipientAddr = addressOf(recipientRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(senderRing[0].puzzleHashHex), 5_000_000_000_000n);
    const launcherId = mintNftTo(sim, senderRing[0]);
    const chain = simChain(sim);

    // Sender owns it before the transfer.
    expect(await listNfts(asNft(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(1);

    const prepared = await prepareNftTransfer(asNft(), chain, {
      seed: senderSeed,
      launcherId,
      recipient: recipientAddr,
      activeIndex: 0,
    });
    expect(prepared.summary.launcherId).toBe(launcherId);
    expect(prepared.summary.recipientPuzzleHashHex).toBe(recipientRing[0].puzzleHashHex);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    const res = await chain.pushSpendBundle(bundle);
    expect(res.success).toBe(true);

    // The NFT moved: gone from the sender, discoverable by the recipient (proves the transfer + hint).
    expect(await listNfts(asNft(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(0);
    const recipientNfts = await listNfts(asNft(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientNfts).toHaveLength(1);
    expect(recipientNfts[0].launcherId).toBe(launcherId);
    expect(recipientNfts[0].p2PuzzleHash).toBe(recipientRing[0].puzzleHashHex);
  });

  it('pays a fee from the wallet when transferring', async () => {
    const senderSeed = await mnemonicToSeed(golden.mnemonic);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const senderRing = buildKeyring(asFlow(), senderSeed, { index: 0 });
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });

    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(senderRing[0].puzzleHashHex), 5_000_000_000_000n);
    const launcherId = mintNftTo(sim, senderRing[0]);
    const chain = simChain(sim);

    const prepared = await prepareNftTransfer(asNft(), chain, {
      seed: senderSeed,
      launcherId,
      recipient: addressOf(recipientRing[0].puzzleHashHex),
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const recipientNfts = await listNfts(asNft(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientNfts.map((n) => n.launcherId)).toContain(launcherId);
  });

  it('returns an empty list when the wallet holds no NFTs', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    expect(await listNfts(asNft(), simChain(sim), { seed, activeIndex: 0 })).toEqual([]);
  });

  it('throws NFT_NOT_FOUND when transferring an NFT the wallet does not hold', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 1_000_000_000_000n);
    await expect(
      prepareNftTransfer(asNft(), simChain(sim), { seed, launcherId: 'ab'.repeat(32), recipient: addressOf(ring[0].puzzleHashHex), activeIndex: 0 }),
    ).rejects.toThrow(/NFT_NOT_FOUND/);
  });

  it('throws HINT_LOOKUP_UNAVAILABLE when the chain cannot resolve hints', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const chain = { getCoinSpend: async () => null, unspentCoins: async () => [] } as unknown as NftChain;
    await expect(listNfts(asNft(), chain, { seed, activeIndex: 0 })).rejects.toThrow(/HINT_LOOKUP_UNAVAILABLE/);
  });
});

describe('nfts — mint via prepareNftMint (Simulator-validated, #92)', () => {
  const DATA_URI = 'https://example.test/img.png';
  const META_URI = 'https://example.test/meta.json';
  const LICENSE_URI = 'https://example.test/license.txt';
  const DATA_HASH = 'ab'.repeat(32);

  /** A funded sim + the minter's keyring (index-0 holds 5 XCH). */
  async function fundedMinter(): Promise<{ seed: Uint8Array; ring: ReturnType<typeof buildKeyring>; sim: SimHandle; chain: NftChain }> {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    return { seed, ring, sim, chain: simChain(sim) };
  }

  it('mints an NFT owned by the wallet with the given CHIP-0007 metadata + royalty', async () => {
    const { seed, ring, chain } = await fundedMinter();
    const prepared = await prepareNftMint(asNft(), chain, {
      seed,
      dataUris: [DATA_URI],
      dataHash: DATA_HASH,
      metadataUris: [META_URI],
      licenseUris: [LICENSE_URI],
      royaltyBasisPoints: 250,
      activeIndex: 0,
    });
    // The summary is decoded from the built spend → asserting it proves what will be minted.
    expect(prepared.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.summary.royaltyBasisPoints).toBe(250);
    expect(prepared.summary.dataUris).toEqual([DATA_URI]);
    expect(prepared.summary.metadataUris).toEqual([META_URI]);
    expect(prepared.summary.licenseUris).toEqual([LICENSE_URI]);
    expect(prepared.summary.editionNumber).toBe('1');
    // Royalty defaults to the minter (index-0).
    expect(prepared.summary.royaltyPuzzleHashHex).toBe(ring[0].puzzleHashHex);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    // The Simulator accepted it → the NFT is now discoverable by, and owned by, the minter.
    const nfts = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(nfts).toHaveLength(1);
    expect(nfts[0].launcherId).toBe(prepared.launcherId);
    expect(nfts[0].p2PuzzleHash).toBe(ring[0].puzzleHashHex);
    expect(nfts[0].royaltyBasisPoints).toBe(250);
    expect(nfts[0].dataUris).toEqual([DATA_URI]);
    expect(nfts[0].dataHash).toBe(DATA_HASH);
    expect(nfts[0].metadataUris).toEqual([META_URI]);
    expect(nfts[0].licenseUris).toEqual([LICENSE_URI]);
  });

  it('pays a fee from the wallet when minting', async () => {
    const { seed, chain } = await fundedMinter();
    const prepared = await prepareNftMint(asNft(), chain, { seed, dataUris: [DATA_URI], fee: 1_000_000n, activeIndex: 0 });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const nfts = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(nfts.map((n) => n.launcherId)).toContain(prepared.launcherId);
  });

  it('routes the royalty payout to a specified address when given', async () => {
    const { seed, chain } = await fundedMinter();
    const royaltySeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const royaltyRing = buildKeyring(asFlow(), royaltySeed, { index: 0 });
    const prepared = await prepareNftMint(asNft(), chain, {
      seed,
      dataUris: [DATA_URI],
      royaltyBasisPoints: 500,
      royaltyAddress: addressOf(royaltyRing[0].puzzleHashHex),
      activeIndex: 0,
    });
    expect(prepared.summary.royaltyPuzzleHashHex).toBe(royaltyRing[0].puzzleHashHex);
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const nfts = await listNfts(asNft(), chain, { seed, activeIndex: 0 });
    expect(nfts[0].royaltyPuzzleHash).toBe(royaltyRing[0].puzzleHashHex);
    expect(nfts[0].royaltyBasisPoints).toBe(500);
  });

  it('rejects a mint with no data URI (nothing to mint)', async () => {
    const { seed, chain } = await fundedMinter();
    await expect(prepareNftMint(asNft(), chain, { seed, dataUris: [], activeIndex: 0 })).rejects.toThrow(/NO_DATA_URI/);
  });

  it('rejects a mint when the wallet has no XCH to fund it', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const sim = new chia.Simulator(); // no coins funded
    await expect(prepareNftMint(asNft(), simChain(sim), { seed, dataUris: [DATA_URI], activeIndex: 0 })).rejects.toThrow();
  });
});

describe('nfts — bulk transfer + burn (Simulator-validated, #171)', () => {
  /** Mint `n` NFTs to the sender's index-0 wallet, returning their launcher ids (mint order). */
  function mintMany(sim: SimHandle, ring0: ReturnType<typeof buildKeyring>[number], n: number): string[] {
    return Array.from({ length: n }, () => mintNftTo(sim, ring0));
  }

  /** A sim funded with enough XCH for several mints + a fee-paying bulk spend. */
  async function fundedSenderWithNfts(count: number): Promise<{ seed: Uint8Array; ring: ReturnType<typeof buildKeyring>; sim: SimHandle; chain: NftChain; launcherIds: string[] }> {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const ring = buildKeyring(asFlow(), seed, { index: 0 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(ring[0].puzzleHashHex), 5_000_000_000_000n);
    const launcherIds = mintMany(sim, ring[0], count);
    return { seed, ring, sim, chain: simChain(sim), launcherIds };
  }

  it('the well-known mainnet burn address decodes to the canonical provably-unspendable puzzle hash', () => {
    // xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm6ks6e8mvy — 30 zero bytes + 0xDE 0xAD
    // (docs.chia.net/faq#what-is-chia-burn-address). Pinning the decode proves NFT_BURN_PUZZLE_HASH
    // is byte-identical to the address every wallet/explorer recognizes as "burned", not a look-alike.
    const decoded = chia.Address.decode('xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm6ks6e8mvy');
    expect(hx(decoded.puzzleHash)).toBe(hx(NFT_BURN_PUZZLE_HASH));
    expect(hx(NFT_BURN_PUZZLE_HASH)).toBe('0'.repeat(60) + 'dead');
  });

  it('bulk-transfers multiple NFTs to another wallet in ONE spend bundle', async () => {
    const { seed: senderSeed, chain, launcherIds } = await fundedSenderWithNfts(2);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });
    const recipientAddr = addressOf(recipientRing[0].puzzleHashHex);

    expect(await listNfts(asNft(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(2);

    const prepared = await prepareNftBulkTransfer(asNft(), chain, {
      seed: senderSeed,
      launcherIds,
      recipient: recipientAddr,
      activeIndex: 0,
    });
    expect(prepared.summary.launcherIds.sort()).toEqual([...launcherIds].sort());
    expect(prepared.summary.recipientPuzzleHashHex).toBe(recipientRing[0].puzzleHashHex);
    expect(prepared.summary.isBurn).toBe(false);
    // One NFT inner spend per selected NFT, all aggregated into ONE bundle/broadcast.
    expect(prepared.coinSpends).toHaveLength(2);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    // Both NFTs moved together: gone from the sender, both discoverable by the recipient.
    expect(await listNfts(asNft(), chain, { seed: senderSeed, activeIndex: 0 })).toHaveLength(0);
    const recipientNfts = await listNfts(asNft(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientNfts.map((n) => n.launcherId).sort()).toEqual([...launcherIds].sort());
  });

  it('pays ONE fee from the wallet for the whole bulk transfer', async () => {
    const { seed: senderSeed, chain, launcherIds } = await fundedSenderWithNfts(2);
    const recipientSeed = await mnemonicToSeed(RECIPIENT_MNEMONIC);
    const recipientRing = buildKeyring(asFlow(), recipientSeed, { index: 0 });

    const prepared = await prepareNftBulkTransfer(asNft(), chain, {
      seed: senderSeed,
      launcherIds,
      recipient: addressOf(recipientRing[0].puzzleHashHex),
      fee: 1_000_000n,
      activeIndex: 0,
    });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    const recipientNfts = await listNfts(asNft(), chain, { seed: recipientSeed, activeIndex: 0 });
    expect(recipientNfts).toHaveLength(2);
  });

  it('rejects a bulk transfer with no NFTs selected', async () => {
    const { seed, chain } = await fundedSenderWithNfts(0);
    await expect(
      prepareNftBulkTransfer(asNft(), chain, { seed, launcherIds: [], recipient: addressOf('00'.repeat(32)), activeIndex: 0 }),
    ).rejects.toThrow(/NO_NFTS_SELECTED/);
  });

  it('rejects a bulk transfer when one of the selected NFTs is not owned', async () => {
    const { seed, chain, launcherIds } = await fundedSenderWithNfts(1);
    await expect(
      prepareNftBulkTransfer(asNft(), chain, {
        seed,
        launcherIds: [...launcherIds, 'ab'.repeat(32)],
        recipient: addressOf('00'.repeat(32)),
        activeIndex: 0,
      }),
    ).rejects.toThrow(/NFT_NOT_FOUND/);
  });

  it('bulk-burns multiple NFTs to the well-known provably-unspendable address in ONE spend bundle', async () => {
    const { seed, chain, launcherIds } = await fundedSenderWithNfts(2);
    expect(await listNfts(asNft(), chain, { seed, activeIndex: 0 })).toHaveLength(2);

    const prepared = await prepareNftBulkBurn(asNft(), chain, { seed, launcherIds, activeIndex: 0 });
    expect(prepared.summary.isBurn).toBe(true);
    expect(prepared.summary.recipientPuzzleHashHex).toBe(hx(NFT_BURN_PUZZLE_HASH));
    expect(prepared.summary.launcherIds.sort()).toEqual([...launcherIds].sort());
    expect(prepared.coinSpends).toHaveLength(2);

    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);

    // Burned: gone from the sender, and unrecoverable (no wallet — including a `p2PuzzleHash` scan
    // over the burn hash itself — can ever discover a coin sent to the all-zero+dead puzzle hash).
    expect(await listNfts(asNft(), chain, { seed, activeIndex: 0 })).toHaveLength(0);
  });

  it('pays a fee from the wallet when burning', async () => {
    const { seed, chain, launcherIds } = await fundedSenderWithNfts(1);
    const prepared = await prepareNftBulkBurn(asNft(), chain, { seed, launcherIds, fee: 1_000_000n, activeIndex: 0 });
    expect(prepared.summary.fee).toBe('1000000');
    const bundle = signAndBundle(asFlow(), prepared.coinSpends, prepared.secretKeys, TESTNET11_AGG_SIG_ME);
    expect((await chain.pushSpendBundle(bundle)).success).toBe(true);
    expect(await listNfts(asNft(), chain, { seed, activeIndex: 0 })).toHaveLength(0);
  });

  it('rejects a bulk burn with no NFTs selected', async () => {
    const { seed, chain } = await fundedSenderWithNfts(0);
    await expect(prepareNftBulkBurn(asNft(), chain, { seed, launcherIds: [], activeIndex: 0 })).rejects.toThrow(/NO_NFTS_SELECTED/);
  });

  it('rejects a bulk burn when one of the selected NFTs is not owned', async () => {
    const { seed, chain, launcherIds } = await fundedSenderWithNfts(1);
    await expect(
      prepareNftBulkBurn(asNft(), chain, { seed, launcherIds: [...launcherIds, 'cd'.repeat(32)], activeIndex: 0 }),
    ).rejects.toThrow(/NFT_NOT_FOUND/);
  });
});
