/**
 * Self-custody NFTs / Collectibles (§18 NFTs, #56 Phase-1 Sage parity) — LIST the wallet's NFTs and
 * TRANSFER one, assembled from `chia-wallet-sdk-wasm` primitives so the spends are byte-identical to
 * the canonical `chia-sdk-driver` construction (they interoperate with Sage / dexie). Runs in the
 * offscreen vault (holds the seed). Pure (injected wasm + chain); the transfer money path is proven
 * consensus-valid by a Simulator test (`nfts.test.ts`) — nothing is broadcast in CI.
 *
 * NFT discovery model (mirrors the CAT lineage reconstruction in `sendFlow.reconstructCats`):
 *   - An NFT is a singleton whose OUTER coin puzzle hash is the full singleton/ownership puzzle — NOT
 *     the wallet's p2 (standard) puzzle hash — so it is NOT found by a puzzle-hash scan. Instead the
 *     transfer that delivered it HINTS the recipient's inner p2 puzzle hash, so the wallet finds its
 *     NFT coins via coinset `get_coin_records_by_hints` over its derived p2 hashes.
 *   - For each hinted unspent coin, its PARENT spend is fetched and `Puzzle.parseChildNft(parentCoin,
 *     parentSolution)` reconstructs the child `Nft` (exactly parallel to `Puzzle.parseChildCats`).
 *     A coin is one of OUR NFTs iff the reconstructed child is this coin and its `info.p2PuzzleHash`
 *     is one of the wallet's derived inner puzzle hashes.
 *
 * Transfer model: add the reconstructed `Nft` to a `Spends` driver, `Action.send(Id.existing(
 * launcherId), destP2, 1, hintMemo)` (a singleton is amount 1; the recipient p2 is carried as the
 * create-coin hint so the recipient can discover it), pay the fee in XCH, then insert a standard
 * inner spend for each pending coin. Does NOT sign or broadcast — the vault's confirm step does that
 * on explicit user approval (reusing the same sign+broadcast+poll machinery as Send).
 */

import { buildKeyring, type KeyringEntry, type SendFlowWasm } from '@/offscreen/sendFlow';
import { type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import type { ChainClient } from '@/offscreen/chain';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

// ── Minimal structural wasm surfaces (focused casts, per sendFlow/offers) ─────────────────────────
interface NftMetadataObj {
  editionNumber: bigint;
  editionTotal: bigint;
  dataUris: string[];
  dataHash?: Uint8Array;
  metadataUris: string[];
  metadataHash?: Uint8Array;
  licenseUris: string[];
  licenseHash?: Uint8Array;
}
interface NftMetadataProgram {
  parseNftMetadata(): NftMetadataObj | undefined;
}
interface NftInfoObj {
  launcherId: Uint8Array;
  metadata: NftMetadataProgram;
  currentOwner?: Uint8Array;
  royaltyPuzzleHash: Uint8Array;
  royaltyBasisPoints: number;
  p2PuzzleHash: Uint8Array;
}
interface NftObj {
  coin: { coinId(): Uint8Array; amount: bigint };
  info: NftInfoObj;
}
interface NftPuzzle {
  parseChildNft(parentCoin: unknown, parentSolution: unknown): NftObj | undefined;
}
interface NftProgram {
  puzzle(): NftPuzzle;
}
interface NftPendingSpend {
  coin(): { coinId(): Uint8Array };
  p2PuzzleHash(): Uint8Array;
  conditions(): unknown[];
}
interface NftFinished {
  pendingSpends(): NftPendingSpend[];
  insert(coinId: Uint8Array, spend: unknown): void;
  spend(): unknown;
}
interface NftSpends {
  addXch(coin: unknown): void;
  addNft(nft: NftObj): void;
  apply(actions: unknown[]): unknown;
  prepare(deltas: unknown): NftFinished;
}
interface NftClvm {
  deserialize(bytes: Uint8Array): NftProgram;
  alloc(value: unknown): unknown;
  standardSpend(syntheticKey: unknown, spend: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  coinSpends(): SigCoinSpend[];
  /** Encode a {@link NftMetadata} into a CLVM `Program` bound to THIS allocator (mint path). */
  nftMetadata(metadata: unknown): unknown;
}
/** The mint outputs returned by `finished.spend()` — the freshly-minted NFT(s) with their info. */
interface NftMintOutputs {
  nfts(): unknown[];
  nft(id: unknown): { info: { launcherId: Uint8Array } };
}

/**
 * The full wasm surface the NFT engine needs. Standalone (NOT `extends SendFlowWasm`) because it
 * types `Clvm`/`Spends`/`Action`/`Id` more richly; the shared derivation helper (`buildKeyring`)
 * receives a focused `as unknown as SendFlowWasm` cast, and the offscreen vault signs the result via
 * `signAndBundle` (which owns the signer cast).
 */
export interface NftWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  standardPuzzleHash(syntheticKey: unknown): Uint8Array;
  Clvm: new () => NftClvm;
  Spends: new (clvm: NftClvm, changePuzzleHash: Uint8Array) => NftSpends;
  Address: { decode(address: string): { puzzleHash: Uint8Array } };
  Action: {
    send(id: unknown, puzzleHash: Uint8Array, amount: bigint, memos: unknown): unknown;
    fee(amount: bigint): unknown;
    /** Mint one NFT: metadata (in `clvm`) + updater + royalty payout/bps + amount (1) + optional parent. */
    mintNft(
      clvm: NftClvm,
      metadata: unknown,
      metadataUpdaterPuzzleHash: Uint8Array,
      royaltyPuzzleHash: Uint8Array,
      royaltyBasisPoints: number,
      amount: bigint,
      parentId?: unknown,
    ): unknown;
  };
  Id: { existing(assetId: Uint8Array): unknown };
  /** CHIP-0007 metadata value (edition + data/metadata/license URIs + optional hashes). */
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
  /** Puzzle-hash constants — the default metadata-updater hash the mint stamps into the NFT. */
  Constants: { nftMetadataUpdaterDefaultHash(): Uint8Array };
  // Derivation surface reused via a cast to SendFlowWasm.
  SecretKey: unknown;
}

const asHex = (chia: NftWasm, b: Uint8Array): string => strip0x(chia.toHex(b));

/** A wallet-owned NFT, flattened to wire-safe (JSON, no bigint) display fields. */
export interface WalletNft {
  /** The singleton launcher id (hex) — the NFT's stable identity. */
  launcherId: string;
  /** The current NFT coin id (hex) that holds it. */
  coinId: string;
  /** Which derived inner (p2) puzzle hash of THIS wallet holds it (hex). */
  p2PuzzleHash: string;
  /** The minter/collection grouping signal: the current owner DID (hex) if set, else null. */
  collectionId: string | null;
  /** CHIP-0007 edition number / total (decimal strings). */
  editionNumber: string;
  editionTotal: string;
  /** Royalty basis points (e.g. 250 = 2.5%). */
  royaltyBasisPoints: number;
  /** The royalty payout puzzle hash (hex). */
  royaltyPuzzleHash: string;
  /** On-chain data / metadata / license URIs + hashes (hex, or null). */
  dataUris: string[];
  dataHash: string | null;
  metadataUris: string[];
  metadataHash: string | null;
  licenseUris: string[];
}

/** The chain surface the NFT engine needs — the standard {@link ChainClient} plus a hint lookup. */
export type NftChain = ChainClient;

/**
 * Reconstruct a wallet-owned {@link NftObj} handle from a hinted unspent coin, or null if not ours.
 * The caller supplies the `clvm` so the reconstructed NFT's `metadata` Program lives in the SAME CLVM
 * allocator that will later consume it (the `Spends` driver) — a cross-arena handle panics the wasm.
 */
async function reconstructOwnedNft(
  chia: NftWasm,
  chain: NftChain,
  clvm: NftClvm,
  ownedPhs: Set<string>,
  coin: { coinId(): Uint8Array; parentCoinInfo: Uint8Array },
): Promise<NftObj | null> {
  const parentSpend = await chain.getCoinSpend(asHex(chia, coin.parentCoinInfo));
  if (!parentSpend) return null;
  const puzzle = clvm.deserialize(parentSpend.puzzleReveal).puzzle();
  const nft = puzzle.parseChildNft(parentSpend.coin, clvm.deserialize(parentSpend.solution));
  if (!nft) return null;
  // The reconstructed child must BE this coin, and its inner p2 must be one of ours.
  if (asHex(chia, nft.coin.coinId()) !== asHex(chia, coin.coinId())) return null;
  if (!ownedPhs.has(asHex(chia, nft.info.p2PuzzleHash))) return null;
  return nft;
}

/** Flatten a reconstructed {@link NftObj} to a wire-safe {@link WalletNft}. */
function toWalletNft(chia: NftWasm, nft: NftObj): WalletNft {
  const meta = nft.info.metadata.parseNftMetadata();
  return {
    launcherId: asHex(chia, nft.info.launcherId),
    coinId: asHex(chia, nft.coin.coinId()),
    p2PuzzleHash: asHex(chia, nft.info.p2PuzzleHash),
    collectionId: nft.info.currentOwner ? asHex(chia, nft.info.currentOwner) : null,
    editionNumber: (meta?.editionNumber ?? 1n).toString(),
    editionTotal: (meta?.editionTotal ?? 1n).toString(),
    royaltyBasisPoints: nft.info.royaltyBasisPoints,
    royaltyPuzzleHash: asHex(chia, nft.info.royaltyPuzzleHash),
    dataUris: meta?.dataUris ?? [],
    dataHash: meta?.dataHash ? asHex(chia, meta.dataHash) : null,
    metadataUris: meta?.metadataUris ?? [],
    metadataHash: meta?.metadataHash ? asHex(chia, meta.metadataHash) : null,
    licenseUris: meta?.licenseUris ?? [],
  };
}

/**
 * List the wallet's NFTs. Derives the HD keyring (both schemes to `gapLimit`), finds the coins
 * hinted to those inner puzzle hashes (coinset `get_coin_records_by_hints`), reconstructs each as an
 * NFT via its parent spend, and keeps those actually owned by the wallet. Deduped by launcher id
 * (the newest coin wins per launcher). Read-only — never signs or broadcasts.
 */
export async function listNfts(
  chia: NftWasm,
  chain: NftChain,
  opts: { seed: Uint8Array; gapLimit?: number },
): Promise<WalletNft[]> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const coins = await chain.coinsByHints([...ownedPhs]);
  const clvm = new chia.Clvm();
  const byLauncher = new Map<string, WalletNft>();
  for (const coin of coins) {
    const nft = await reconstructOwnedNft(chia, chain, clvm, ownedPhs, coin);
    if (!nft) continue;
    const wallet = toWalletNft(chia, nft);
    byLauncher.set(wallet.launcherId, wallet);
  }
  return [...byLauncher.values()];
}

/** A prepared (unsigned) NFT transfer: coin spends + the keys to sign + the decoded summary. */
export interface PreparedNftTransfer {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: NftTransferSummary;
}
/** The decoded, tamper-resistant summary of an NFT transfer for the user to approve. */
export interface NftTransferSummary {
  launcherId: string;
  recipientPuzzleHashHex: string;
  fee: string;
  coinCount: number;
}

/**
 * Locate the wallet's NFT of `launcherId` as a live wasm `Nft` handle reconstructed in `clvm` (the
 * same allocator the `Spends` driver uses). Throws `NFT_NOT_FOUND` if the wallet no longer holds it.
 */
async function findNftForTransfer(
  chia: NftWasm,
  chain: NftChain,
  clvm: NftClvm,
  keyring: KeyringEntry[],
  launcherId: string,
): Promise<NftObj> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const wantId = strip0x(launcherId);
  const coins = await chain.coinsByHints([...ownedPhs]);
  for (const coin of coins) {
    const nft = await reconstructOwnedNft(chia, chain, clvm, ownedPhs, coin);
    if (nft && asHex(chia, nft.info.launcherId) === wantId) return nft;
  }
  throw new Error('NFT_NOT_FOUND: the wallet does not hold this NFT');
}

/**
 * Prepare (build, don't sign/broadcast) a transfer of the wallet's NFT `launcherId` to `recipient`.
 * Pays `fee` (XCH) from the wallet's coins. Returns the coin spends, the signing keys, and a decoded
 * summary. The recipient's p2 puzzle hash is carried as the create-coin hint so they discover it.
 */
export async function prepareNftTransfer(
  chia: NftWasm,
  chain: NftChain,
  opts: { seed: Uint8Array; launcherId: string; recipient: string; fee?: bigint; gapLimit?: number },
): Promise<PreparedNftTransfer> {
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const clvm = new chia.Clvm();
  const nft = await findNftForTransfer(chia, chain, clvm, keyring, opts.launcherId);

  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);
  const spends = new chia.Spends(clvm, changePuzzleHash);
  spends.addNft(nft);
  if (fee > 0n) {
    const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
    for (const c of xchCoins) spends.addXch(c);
  }

  const nftId = chia.Id.existing(chia.fromHex(strip0x(opts.launcherId)));
  const hintMemo = clvm.alloc([destPuzzleHash]); // recipient p2 as the create-coin hint
  const actions: unknown[] = [chia.Action.send(nftId, destPuzzleHash, 1n, hintMemo)];
  if (fee > 0n) actions.push(chia.Action.fee(fee));

  const finished = spends.prepare(spends.apply(actions));
  for (const ps of finished.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  finished.spend();

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys: keyring.map((k) => k.sk),
    summary: {
      launcherId: strip0x(opts.launcherId),
      recipientPuzzleHashHex: asHex(chia, destPuzzleHash),
      fee: fee.toString(),
      coinCount: coinSpends.length,
    },
  };
}

/** The CHIP-0007 metadata + royalty inputs to a mint (URIs plain, hashes hex, amounts optional). */
export interface NftMintParams {
  /** Data (media) URIs — REQUIRED (at least one); the primary asset the NFT points at. */
  dataUris: string[];
  /** SHA-256 of the data content (hex), optional but recommended for integrity. */
  dataHash?: string;
  /** Metadata JSON URIs (CHIP-0007 off-chain metadata document). */
  metadataUris?: string[];
  metadataHash?: string;
  /** License document URIs. */
  licenseUris?: string[];
  licenseHash?: string;
  /** Edition position — defaults to 1 / 1 (a one-of-one). */
  editionNumber?: bigint;
  editionTotal?: bigint;
  /** Royalty in basis points (e.g. 250 = 2.5%); defaults to 0. */
  royaltyBasisPoints?: number;
  /** Royalty payout address (bech32m `xch1…`); defaults to the minter (index-0). */
  royaltyAddress?: string;
  /** Network fee in mojos; defaults to 0. */
  fee?: bigint;
}

/** A prepared (unsigned) NFT mint: the coin spends, the keys to sign, the summary, and the launcher id. */
export interface PreparedNftMint {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: NftMintSummary;
  /** The new NFT's singleton launcher id (hex) — its stable identity once broadcast. */
  launcherId: string;
}

/** The decoded, tamper-resistant summary of a mint (decoded from the BUILT spend) for the user to approve. */
export interface NftMintSummary {
  launcherId: string;
  dataUris: string[];
  metadataUris: string[];
  licenseUris: string[];
  editionNumber: string;
  editionTotal: string;
  royaltyBasisPoints: number;
  /** Where royalties are paid (hex) — the minter by default, or the chosen royalty address. */
  royaltyPuzzleHashHex: string;
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) a mint of ONE new NFT owned by this wallet (§18, #92). The
 * NFT carries CHIP-0007 metadata (data/metadata/license URIs + optional hashes), a royalty percentage
 * paid to the minter (or a chosen address), and a standard metadata updater. The singleton (amount 1)
 * and change are funded from the wallet's XCH coins and returned to index-0, so the new NFT is minted
 * to — and discoverable by — this wallet. Returns the coin spends, the signing keys, the launcher id,
 * and a summary decoded from the built spend. Does NOT sign or broadcast — the vault's confirm step
 * does that on explicit user approval (reusing the Send sign+broadcast+poll machinery).
 *
 * The metadata CLVM `Program` is built in the SAME `Clvm` the `Spends` driver consumes (a cross-arena
 * metadata handle traps the wasm). Assigning the NFT to a DID owner at mint requires owning + co-
 * spending that DID and is a follow-up with DID management (#93).
 */
export async function prepareNftMint(
  chia: NftWasm,
  chain: NftChain,
  opts: { seed: Uint8Array; gapLimit?: number } & NftMintParams,
): Promise<PreparedNftMint> {
  if (!opts.dataUris || opts.dataUris.length === 0) throw new Error('NO_DATA_URI: a mint requires at least one data URI');
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));

  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  if (xchCoins.length === 0) throw new Error('NO_XCH_COINS: the wallet has no XCH to fund the mint');

  const clvm = new chia.Clvm();
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex); // the new NFT + change go here (self)
  const spends = new chia.Spends(clvm, changePuzzleHash);
  for (const c of xchCoins) spends.addXch(c);

  const optHash = (hex?: string): Uint8Array | undefined => (hex ? chia.fromHex(strip0x(hex)) : undefined);
  const metadataValue = new chia.NftMetadata(
    opts.editionNumber ?? 1n,
    opts.editionTotal ?? 1n,
    opts.dataUris,
    optHash(opts.dataHash),
    opts.metadataUris ?? [],
    optHash(opts.metadataHash),
    opts.licenseUris ?? [],
    optHash(opts.licenseHash),
  );
  const metadata = clvm.nftMetadata(metadataValue);
  const royaltyPuzzleHash = opts.royaltyAddress ? chia.Address.decode(opts.royaltyAddress).puzzleHash : changePuzzleHash;
  const royaltyBasisPoints = opts.royaltyBasisPoints ?? 0;

  const actions: unknown[] = [
    chia.Action.mintNft(clvm, metadata, chia.Constants.nftMetadataUpdaterDefaultHash(), royaltyPuzzleHash, royaltyBasisPoints, 1n, undefined),
  ];
  if (fee > 0n) actions.push(chia.Action.fee(fee));

  const finished = spends.prepare(spends.apply(actions));
  for (const ps of finished.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a funding coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  const outputs = finished.spend() as unknown as NftMintOutputs;
  const launcherId = asHex(chia, outputs.nft(outputs.nfts()[0]).info.launcherId);

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys: keyring.map((k) => k.sk),
    launcherId,
    summary: {
      launcherId,
      dataUris: opts.dataUris,
      metadataUris: opts.metadataUris ?? [],
      licenseUris: opts.licenseUris ?? [],
      editionNumber: (opts.editionNumber ?? 1n).toString(),
      editionTotal: (opts.editionTotal ?? 1n).toString(),
      royaltyBasisPoints,
      royaltyPuzzleHashHex: asHex(chia, royaltyPuzzleHash),
      fee: fee.toString(),
      coinCount: coinSpends.length,
    },
  };
}
