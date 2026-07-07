import { describe, it, expect, beforeAll } from 'vitest';
import { makeOffer, inspectOffer, takeOffer, cancelOffer, offerNonce, type OfferWasm } from './offers';
import { buildKeyring, type SendFlowWasm } from './sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from './signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from './chain';
import { mnemonicToSeed, entropyToMnemonic } from '@/lib/keystore/bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from '@/lib/keystore/derive.golden.json';

/**
 * Offer engine, proven authoritatively against the wasm Simulator: a two-party settlement where the
 * maker builds an offer and a DIFFERENT seed-derived wallet takes it — the Simulator accepts the
 * combined bundle and BOTH sides' balances land. Read-only in CI (never broadcasts to mainnet). The
 * engine signs with the injected testnet11 genesis so the Simulator (testnet11) validates it.
 */
interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  lookupPuzzleHashes(puzzleHashes: Uint8Array[], includeHints: boolean): { coin: ChainCoin }[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}
interface TestWasm extends OfferWasm {
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
  Constants: OfferWasm['Constants'] & { nftMetadataUpdaterDefaultHash(): Uint8Array };
}

// golden.mnemonic is the all-abandon vector, so derive a DISTINCT taker wallet from fixed entropy.
const TAKER_MNEMONIC = entropyToMnemonic(new Uint8Array(32).fill(7));

let chia: TestWasm;
const asOffer = () => chia as unknown as OfferWasm;
const asFlow = () => chia as unknown as SendFlowWasm;
const asSig = () => chia as unknown as SigningWasm;
const hx = (b: Uint8Array) => chia.toHex(b).replace(/^0x/i, '').toLowerCase();

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** A sim-backed ChainClient covering every method the offer engine calls (incl. hint discovery for NFTs). */
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

/** Mint a single NFT to a seed-derived wallet's index-0 address, with the given royalty (bps). */
function mintNftTo(sim: SimHandle, ring0: ReturnType<typeof buildKeyring>[number], royaltyBasisPoints: number): string {
  const ph0 = chia.fromHex(ring0.puzzleHashHex);
  const clvm = new (chia as unknown as { Clvm: new () => { nftMetadata(v: unknown): unknown; standardSpend(pk: unknown, s: unknown): unknown; delegatedSpend(c: unknown[]): unknown; coinSpends(): ChainCoinSpend[] } }).Clvm();
  const spends = new (chia as unknown as {
    Spends: new (c: unknown, ph: Uint8Array) => {
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
  const metadata = clvm.nftMetadata(new chia.NftMetadata(1n, 1n, ['https://example.test/img.png'], undefined, [], undefined, []));
  const mintAction = (chia as unknown as {
    Action: { mintNft(c: unknown, m: unknown, u: Uint8Array, r: Uint8Array, bps: number, amt: bigint, parent?: unknown): unknown };
  }).Action.mintNft(clvm, metadata, chia.Constants.nftMetadataUpdaterDefaultHash(), ph0, royaltyBasisPoints, 1n, undefined);
  const fin = spends.prepare(spends.apply([mintAction]));
  for (const ps of fin.pendingSpends()) fin.insert(ps.coin().coinId(), clvm.standardSpend(ring0.pk, clvm.delegatedSpend(ps.conditions())));
  const outputs = fin.spend();
  const launcherId = hx(outputs.nft(outputs.nfts()[0]).info.launcherId);
  const issue = clvm.coinSpends();
  const sig = signCoinSpends(asSig(), issue as never, [ring0.sk], TESTNET11_AGG_SIG_ME);
  sim.newTransaction(new (chia as unknown as { SpendBundle: new (cs: unknown, s: unknown) => ChainSpendBundle }).SpendBundle(issue, sig));
  sim.createBlock();
  return launcherId;
}

/** Mint a single-issuance CAT to a seed-derived wallet's index-0 address; returns the asset id hex. */
function mintCatTo(sim: SimHandle, ring0: ReturnType<typeof buildKeyring>[number]): string {
  const clvm = new (chia as unknown as { Clvm: new () => { delegatedSpend(c: unknown[]): unknown; standardSpend(pk: unknown, s: unknown): unknown; coinSpends(): ChainCoinSpend[] } }).Clvm();
  const spends = new (chia as unknown as { Spends: new (c: unknown, ph: Uint8Array) => { addXch(c: unknown): void; apply(a: unknown[]): unknown; prepare(d: unknown): { pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; conditions(): unknown[] }>; insert(id: Uint8Array, s: unknown): void; spend(): { cats(): unknown[]; cat(id: unknown): Array<{ info: { assetId: Uint8Array } }> } } } }).Spends(clvm, chia.fromHex(ring0.puzzleHashHex));
  const xch = sim.unspentCoins(chia.fromHex(ring0.puzzleHashHex), false)[0];
  spends.addXch(xch);
  const fin = spends.prepare(spends.apply([(chia as unknown as { Action: { singleIssueCat(h: undefined, a: bigint): unknown } }).Action.singleIssueCat(undefined, 1000n)]));
  for (const ps of fin.pendingSpends()) fin.insert(ps.coin().coinId(), clvm.standardSpend(ring0.pk, clvm.delegatedSpend(ps.conditions())));
  const outputs = fin.spend();
  const assetId = hx(outputs.cat(outputs.cats()[0])[0].info.assetId);
  const issue = clvm.coinSpends();
  const sig = signCoinSpends(asSig(), issue as never, [ring0.sk], TESTNET11_AGG_SIG_ME);
  sim.newTransaction(new (chia as unknown as { SpendBundle: new (cs: unknown, s: unknown) => ChainSpendBundle }).SpendBundle(issue, sig));
  sim.createBlock();
  return assetId;
}

describe('offerNonce', () => {
  it('is order-independent (sorts coin ids before tree-hashing)', () => {
    const clvm = new (chia as unknown as { Clvm: new () => Parameters<typeof offerNonce>[0] }).Clvm();
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(hx(offerNonce(clvm, [a, b]))).toBe(hx(offerNonce(clvm, [b, a])));
  });
});

describe('offers — two-party settlement (Simulator-validated)', () => {
  it('DIR 1: maker offers a CAT, requests XCH; a taker takes; both balances land', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const takerSeed = await mnemonicToSeed(TAKER_MNEMONIC);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const takerRing = buildKeyring(asFlow(), takerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);
    const takerPh0 = chia.fromHex(takerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 5_000_000_000_000n); // maker XCH (to mint the CAT)
    sim.newCoin(takerPh0, 1_000_000_000_000n); // taker XCH (to pay the requested)
    const assetId = mintCatTo(sim, makerRing[0]);
    const chain = simChain(sim);

    const offeredCat = 300n;
    const requestedXch = 50_000_000_000n;
    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'cat', assetId }, amount: offeredCat },
      requested: { asset: { kind: 'xch' }, amount: requestedXch },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });
    expect(made.offer.startsWith('offer1')).toBe(true);

    const summary = inspectOffer(asOffer(), made.offer);
    expect(summary.offered).toEqual([{ asset: { kind: 'cat', assetId }, amount: offeredCat }]);
    expect(summary.requested[0].asset).toEqual({ kind: 'xch' });
    expect(summary.requested[0].amount).toBe(requestedXch);

    const taken = await takeOffer(asOffer(), chain, { seed: takerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    const res = await chain.pushSpendBundle(taken.bundle); // Simulator validates → no throw = atomic settlement valid
    expect(res.success).toBe(true);

    // maker received the requested XCH; taker received the offered CAT
    const makerXch = sim.unspentCoins(makerPh0, false).map((c) => c.amount);
    expect(makerXch).toContain(requestedXch);
    const takerCat = sim.unspentCoins(chia.catPuzzleHash(chia.fromHex(assetId), takerPh0), false).map((c) => c.amount);
    expect(takerCat).toContain(offeredCat);
  });

  it('DIR 2: maker offers XCH, requests a CAT; a taker takes; both balances land', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const takerSeed = await mnemonicToSeed(TAKER_MNEMONIC);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const takerRing = buildKeyring(asFlow(), takerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);
    const takerPh0 = chia.fromHex(takerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 1_000_000_000_000n); // maker XCH (offered)
    sim.newCoin(takerPh0, 5_000_000_000_000n); // taker XCH (to mint the CAT it will pay)
    const assetId = mintCatTo(sim, takerRing[0]);
    const chain = simChain(sim);

    const offeredXch = 100_000_000_000n;
    const requestedCat = 250n;
    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'xch' }, amount: offeredXch },
      requested: { asset: { kind: 'cat', assetId }, amount: requestedCat },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });

    const summary = inspectOffer(asOffer(), made.offer);
    expect(summary.offered).toEqual([{ asset: { kind: 'xch' }, amount: offeredXch }]);
    expect(summary.requested[0].asset).toEqual({ kind: 'cat', assetId });
    expect(summary.requested[0].amount).toBe(requestedCat);

    const takerXchBefore = sim.unspentCoins(takerPh0, false).reduce((a, c) => a + c.amount, 0n);
    const taken = await takeOffer(asOffer(), chain, { seed: takerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    const res = await chain.pushSpendBundle(taken.bundle);
    expect(res.success).toBe(true);

    // The taker's offered XCH is routed as change (merged into their coin) — assert the balance delta.
    const takerXchAfter = sim.unspentCoins(takerPh0, false).reduce((a, c) => a + c.amount, 0n);
    expect(takerXchAfter - takerXchBefore).toBe(offeredXch);
    const makerCat = sim.unspentCoins(chia.catPuzzleHash(chia.fromHex(assetId), makerPh0), false).map((c) => c.amount);
    expect(makerCat).toContain(requestedCat);
  });

  it('CANCEL: the maker re-spends the offered coins to self, invalidating the offer', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 5_000_000_000_000n);
    const assetId = mintCatTo(sim, makerRing[0]);
    const chain = simChain(sim);

    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'cat', assetId }, amount: 300n },
      requested: { asset: { kind: 'xch' }, amount: 50_000_000_000n },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });

    const cancelled = await cancelOffer(asOffer(), chain, { seed: makerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    const res = await chain.pushSpendBundle(cancelled.bundle); // valid self-spend of the offered coins
    expect(res.success).toBe(true);
    // The maker's full CAT balance is back at their address (nothing locked in settlement).
    const makerCat = sim.unspentCoins(chia.catPuzzleHash(chia.fromHex(assetId), makerPh0), false).map((c) => c.amount);
    expect(makerCat.reduce((a, b) => a + b, 0n)).toBe(1000n);
  });
});

describe('offers — NFT (Simulator-validated, #94)', () => {
  it('DIR 3: maker offers an NFT (no royalty), requests XCH; a taker takes; both sides land', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const takerSeed = await mnemonicToSeed(TAKER_MNEMONIC);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const takerRing = buildKeyring(asFlow(), takerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);
    const takerPh0 = chia.fromHex(takerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 5_000_000_000_000n); // maker XCH (to mint the NFT)
    sim.newCoin(takerPh0, 1_000_000_000_000n); // taker XCH (to pay for the NFT)
    const launcherId = mintNftTo(sim, makerRing[0], 0);
    const chain = simChain(sim);

    const requestedXch = 50_000_000_000n;
    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'nft', launcherId }, amount: 1n },
      requested: { asset: { kind: 'xch' }, amount: requestedXch },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });
    expect(made.offer.startsWith('offer1')).toBe(true);
    expect(made.summary.offered).toEqual([{ asset: { kind: 'nft', launcherId }, amount: 1n }]);

    const summary = inspectOffer(asOffer(), made.offer);
    expect(summary.offered).toEqual([{ asset: { kind: 'nft', launcherId }, amount: 1n }]);
    expect(summary.requested[0].amount).toBe(requestedXch);

    const taken = await takeOffer(asOffer(), chain, { seed: takerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    expect(taken.summary.offered).toEqual([{ asset: { kind: 'nft', launcherId }, amount: 1n }]);
    const res = await chain.pushSpendBundle(taken.bundle); // Simulator validates → no throw = atomic settlement valid
    expect(res.success).toBe(true);

    // maker received the requested XCH; taker now holds the NFT (hinted, discoverable at index-0).
    const makerXch = sim.unspentCoins(makerPh0, false).map((c) => c.amount);
    expect(makerXch).toContain(requestedXch);
    const takerNftCoins = sim.unspentCoins(takerPh0, true).filter((c) => c.amount === 1n);
    expect(takerNftCoins.length).toBeGreaterThan(0);
  });

  it('DIR 4: maker offers an NFT WITH royalty; the taker pays price + royalty to the royalty address', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const takerSeed = await mnemonicToSeed(TAKER_MNEMONIC);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const takerRing = buildKeyring(asFlow(), takerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);
    const takerPh0 = chia.fromHex(takerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 5_000_000_000_000n);
    sim.newCoin(takerPh0, 2_000_000_000_000n);
    const royaltyBasisPoints = 500; // 5%
    const launcherId = mintNftTo(sim, makerRing[0], royaltyBasisPoints); // royalty payout = maker (self) by construction

    const chain = simChain(sim);
    const requestedXch = 1_000_000_000_000n;
    const expectedRoyalty = (requestedXch * BigInt(royaltyBasisPoints)) / 10_000n;
    expect(expectedRoyalty).toBe(50_000_000_000n);

    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'nft', launcherId }, amount: 1n },
      requested: { asset: { kind: 'xch' }, amount: requestedXch },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });

    const makerXchBefore = sim.unspentCoins(makerPh0, false).reduce((a, c) => a + c.amount, 0n);
    const taken = await takeOffer(asOffer(), chain, { seed: takerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    const res = await chain.pushSpendBundle(taken.bundle);
    expect(res.success).toBe(true);

    // The maker (also the royalty payee here) receives BOTH the sale price AND the royalty.
    const makerXchAfter = sim.unspentCoins(makerPh0, false).reduce((a, c) => a + c.amount, 0n);
    expect(makerXchAfter - makerXchBefore).toBe(requestedXch + expectedRoyalty);
    const takerNftCoins = sim.unspentCoins(takerPh0, true).filter((c) => c.amount === 1n);
    expect(takerNftCoins.length).toBeGreaterThan(0);
  });

  it('CANCEL: the maker re-spends the offered NFT to self, invalidating the offer', async () => {
    const makerSeed = await mnemonicToSeed(golden.mnemonic);
    const makerRing = buildKeyring(asFlow(), makerSeed, { count: 2 });
    const makerPh0 = chia.fromHex(makerRing[0].puzzleHashHex);

    const sim = new chia.Simulator();
    sim.newCoin(makerPh0, 5_000_000_000_000n);
    const launcherId = mintNftTo(sim, makerRing[0], 0);
    const chain = simChain(sim);

    const made = await makeOffer(asOffer(), chain, {
      seed: makerSeed,
      offered: { asset: { kind: 'nft', launcherId }, amount: 1n },
      requested: { asset: { kind: 'xch' }, amount: 50_000_000_000n },
      gapLimit: 2,
      additionalDataHex: TESTNET11_AGG_SIG_ME,
    });

    const cancelled = await cancelOffer(asOffer(), chain, { seed: makerSeed, offerStr: made.offer, gapLimit: 2, additionalDataHex: TESTNET11_AGG_SIG_ME });
    const res = await chain.pushSpendBundle(cancelled.bundle);
    expect(res.success).toBe(true);
    // The NFT is still (re-)held by the maker, discoverable via hint.
    const makerNftCoins = sim.unspentCoins(makerPh0, true).filter((c) => c.amount === 1n);
    expect(makerNftCoins.length).toBeGreaterThan(0);
  });

  it('rejects requesting a specific NFT (not yet supported)', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    await expect(
      makeOffer(asOffer(), simChain(new chia.Simulator()), {
        seed,
        offered: { asset: { kind: 'xch' }, amount: 1n },
        requested: { asset: { kind: 'nft', launcherId: 'aa'.repeat(32) }, amount: 1n },
        additionalDataHex: TESTNET11_AGG_SIG_ME,
      }),
    ).rejects.toThrow(/UNSUPPORTED_REQUEST/);
  });
});

describe('offers — validation + errors', () => {
  it('rejects an XCH-for-XCH offer', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    await expect(
      makeOffer(asOffer(), simChain(new chia.Simulator()), {
        seed,
        offered: { asset: { kind: 'xch' }, amount: 1n },
        requested: { asset: { kind: 'xch' }, amount: 1n },
        additionalDataHex: TESTNET11_AGG_SIG_ME,
      }),
    ).rejects.toThrow(/SAME_ASSET/);
  });

  it('rejects trading a token for itself', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    await expect(
      makeOffer(asOffer(), simChain(new chia.Simulator()), {
        seed,
        offered: { asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: 1n },
        requested: { asset: { kind: 'cat', assetId: 'aa'.repeat(32) }, amount: 1n },
        additionalDataHex: TESTNET11_AGG_SIG_ME,
      }),
    ).rejects.toThrow(/SAME_ASSET/);
  });

  it('throws NO_CAT_COINS when offering a token the wallet does not hold', async () => {
    const seed = await mnemonicToSeed(golden.mnemonic);
    const makerRing = buildKeyring(asFlow(), seed, { count: 2 });
    const sim = new chia.Simulator();
    sim.newCoin(chia.fromHex(makerRing[0].puzzleHashHex), 1_000_000_000_000n);
    await expect(
      makeOffer(asOffer(), simChain(sim), {
        seed,
        offered: { asset: { kind: 'cat', assetId: 'bb'.repeat(32) }, amount: 1n },
        requested: { asset: { kind: 'xch' }, amount: 1n },
        gapLimit: 2,
        additionalDataHex: TESTNET11_AGG_SIG_ME,
      }),
    ).rejects.toThrow(/NO_CAT_COINS/);
  });
});
