/**
 * Self-custody DIDs (Decentralized Identifiers, #93) — CREATE, LIST, and TRANSFER a DID, assembled
 * from `chia-wallet-sdk-wasm` primitives so the spends are byte-identical to the canonical
 * `chia-sdk-driver` construction (they interoperate with Sage / dexie). Runs in the offscreen vault
 * (holds the seed). Pure (injected wasm + chain); the create + transfer money paths are proven
 * consensus-valid by a Simulator test (`dids.test.ts`) — nothing is broadcast in CI.
 *
 * Unlike NFTs/CATs, a DID has NO `Action`/`Spends` driver support in chia-wallet-sdk-wasm (no
 * `Action.mintDid`, no `Spends.addDid`) — it is built from the lower-level `Clvm.createEveDid` /
 * `Clvm.spendDid` primitives directly (mirrors the SDK's own napi test suite pattern), funded from a
 * SINGLE wallet-owned XCH coin (the launcher's parent coin id must be known before the spend is
 * built, so the driver's multi-coin auto-selection does not apply here). A wallet whose largest coin
 * cannot cover the DID amount + fee is a known v1 scope limit (`NO_SUITABLE_COIN`); multi-coin
 * funding for DID create/transfer-fee is a follow-up.
 *
 * DID discovery model (mirrors the NFT lineage reconstruction in `nfts.ts`):
 *   - A DID is a singleton whose OUTER coin puzzle hash is the full singleton/DID-layer puzzle — NOT
 *     the wallet's p2 (standard) puzzle hash — so it is NOT found by a puzzle-hash scan. Instead every
 *     DID spend (create or transfer) HINTS the owner's inner p2 puzzle hash via the create-coin memo,
 *     so the wallet finds its DID coins via coinset `get_coin_records_by_hints` over its derived p2
 *     hashes.
 *   - For each hinted unspent coin, its PARENT spend is fetched and `Puzzle.parseChildDid(parentCoin,
 *     parentSolution, coin)` reconstructs the child `Did` (parallel to `Puzzle.parseChildNft`, except
 *     the wasm binding also wants the target child coin to disambiguate DID recovery outputs).
 *     A coin is one of OUR DIDs iff the reconstructed child is this coin and its `info.p2PuzzleHash`
 *     is one of the wallet's derived inner puzzle hashes.
 *
 * Create model: `Clvm.createEveDid(parentCoinId, p2PuzzleHash)` returns the eve `Did` plus the
 * `parentConditions` the funding coin's spend must carry (the launcher creation + its binding
 * announcement); the funding coin is spent directly via `Clvm.spendStandardCoin` (not the
 * `Spends`/`FinishedSpends` driver, which has no DID action). The eve DID is then spent once via
 * `Clvm.spendDid` to commit its real (non-eve) lineage, re-committing to the SAME owner + metadata.
 *
 * Transfer model: recompute the new owner's DID-layer inner puzzle hash from a `DidInfo` carrying the
 * recipient's p2 puzzle hash (same launcher id / recovery list / verifications / metadata), then
 * `Clvm.spendDid(did, standardSpend(ownerPk, delegatedSpend([createCoin(newInnerPuzzleHash, 1,
 * hintMemo)])))`. A fee, when given, is paid from a SEPARATE wallet-owned XCH coin (the DID's own
 * coin carries only 1 mojo). Does NOT sign or broadcast — the vault's confirm step does that on
 * explicit user approval (reusing the same sign+broadcast+poll machinery as Send).
 */

import { buildKeyring, type SendFlowWasm, type KeyringEntry } from '@/offscreen/sendFlow';
import { type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

// ── Minimal structural wasm surfaces (focused casts, per nfts.ts) ────────────────────────────────
interface DidMetadataProgram {
  /** Decodes a plain UTF-8 string atom, or `undefined` for nil/non-string metadata (§ profile). */
  toString(): string | undefined;
}
export interface DidInfoObj {
  launcherId: Uint8Array;
  recoveryListHash?: Uint8Array;
  numVerificationsRequired: bigint;
  metadata: DidMetadataProgram;
  p2PuzzleHash: Uint8Array;
  innerPuzzleHash(): Uint8Array;
}
export interface DidObj {
  coin: { coinId(): Uint8Array; parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint };
  info: DidInfoObj;
  /** The expected child `Did` after re-spending with a new p2 puzzle hash + metadata (same amount). */
  child(p2PuzzleHash: Uint8Array, metadata: unknown): DidObj;
}
interface CreatedDidObj {
  did: DidObj;
  parentConditions: unknown[];
}
interface DidPuzzle {
  parseChildDid(parentCoin: unknown, parentSolution: unknown, coin: unknown): DidObj | undefined;
}
interface DidProgram {
  puzzle(): DidPuzzle;
}
export interface DidClvm {
  spendStandardCoin(coin: unknown, syntheticKey: unknown, spend: unknown): void;
  standardSpend(syntheticKey: unknown, spend: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  createCoin(puzzleHash: Uint8Array, amount: bigint, memos?: unknown): unknown;
  reserveFee(amount: bigint): unknown;
  alloc(value: unknown): unknown;
  deserialize(bytes: Uint8Array): DidProgram;
  coinSpends(): SigCoinSpend[];
  createEveDid(parentCoinId: Uint8Array, p2PuzzleHash: Uint8Array): CreatedDidObj;
  spendDid(did: DidObj, innerSpend: unknown): DidObj | undefined;
}

/** The full wasm surface the DID engine needs (standalone, like `NftWasm`). */
export interface DidWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => DidClvm;
  Address: { decode(address: string): { puzzleHash: Uint8Array } };
  DidInfo: new (
    launcherId: Uint8Array,
    recoveryListHash: Uint8Array | undefined,
    numVerificationsRequired: bigint,
    metadata: unknown,
    p2PuzzleHash: Uint8Array,
  ) => DidInfoObj;
  // Derivation surface reused via a cast to SendFlowWasm.
  SecretKey: unknown;
}

const asHex = (chia: DidWasm, b: Uint8Array): string => strip0x(chia.toHex(b));

/** A wallet-owned DID, flattened to wire-safe (JSON, no bigint) display fields. */
export interface WalletDid {
  /** The singleton launcher id (hex) — the DID's stable identity. */
  launcherId: string;
  /** The current DID coin id (hex) that holds it. */
  coinId: string;
  /** Which derived inner (p2) puzzle hash of THIS wallet owns it (hex). */
  p2PuzzleHash: string;
  /** The recovery-list commitment hash (hex), or null when the DID has no recovery list. */
  recoveryListHash: string | null;
  /** How many recovery-list signatures are required to recover this DID (decimal string). */
  numVerificationsRequired: string;
  /** The DID's on-chain profile name (its `metadata`, decoded as UTF-8), or null if unset. */
  profileName: string | null;
}

/** The chain surface the DID engine needs — the standard {@link ChainClient} plus a hint lookup. */
export type DidChain = ChainClient;

/**
 * Reconstruct a wallet-owned {@link DidObj} handle from a hinted unspent coin, or null if not ours.
 */
async function reconstructOwnedDid(
  chia: DidWasm,
  chain: DidChain,
  clvm: DidClvm,
  ownedPhs: Set<string>,
  coin: ChainCoin,
): Promise<DidObj | null> {
  const parentSpend = await chain.getCoinSpend(asHex(chia, coin.parentCoinInfo));
  if (!parentSpend) return null;
  const puzzle = clvm.deserialize(parentSpend.puzzleReveal).puzzle();
  const did = puzzle.parseChildDid(parentSpend.coin, clvm.deserialize(parentSpend.solution), coin);
  if (!did) return null;
  if (asHex(chia, did.coin.coinId()) !== asHex(chia, coin.coinId())) return null;
  if (!ownedPhs.has(asHex(chia, did.info.p2PuzzleHash))) return null;
  return did;
}

/** Flatten a reconstructed {@link DidObj} to a wire-safe {@link WalletDid}. */
function toWalletDid(chia: DidWasm, did: DidObj): WalletDid {
  return {
    launcherId: asHex(chia, did.info.launcherId),
    coinId: asHex(chia, did.coin.coinId()),
    p2PuzzleHash: asHex(chia, did.info.p2PuzzleHash),
    recoveryListHash: did.info.recoveryListHash ? asHex(chia, did.info.recoveryListHash) : null,
    numVerificationsRequired: did.info.numVerificationsRequired.toString(),
    // A freshly created DID's metadata is the nil atom, whose `toString()` is `''` (not `undefined`,
    // despite the wasm type signature) — treat blank the same as unset.
    profileName: did.info.metadata.toString() || null,
  };
}

/**
 * List the wallet's DIDs. Derives the HD keyring (both schemes to `gapLimit`), finds the coins hinted
 * to those inner puzzle hashes (coinset `get_coin_records_by_hints`), reconstructs each as a DID via
 * its parent spend, and keeps those actually owned by the wallet. Deduped by launcher id (the newest
 * coin wins per launcher). Read-only — never signs or broadcasts.
 */
export async function listDids(
  chia: DidWasm,
  chain: DidChain,
  opts: { seed: Uint8Array; gapLimit?: number },
): Promise<WalletDid[]> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const coins = await chain.coinsByHints([...ownedPhs]);
  const clvm = new chia.Clvm();
  const byLauncher = new Map<string, WalletDid>();
  for (const coin of coins) {
    const did = await reconstructOwnedDid(chia, chain, clvm, ownedPhs, coin);
    if (!did) continue;
    const wallet = toWalletDid(chia, did);
    byLauncher.set(wallet.launcherId, wallet);
  }
  return [...byLauncher.values()];
}

/** A prepared (unsigned) DID create: coin spends + the keys to sign + the decoded summary. */
export interface PreparedDidCreate {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: DidCreateSummary;
  /** The new DID's singleton launcher id (hex) — its stable identity once broadcast. */
  launcherId: string;
}
/** The decoded, tamper-resistant summary of a DID create for the user to approve. */
export interface DidCreateSummary {
  launcherId: string;
  /** The owner's inner (p2) puzzle hash (hex) — the wallet's own funding coin, by construction. */
  p2PuzzleHashHex: string;
  fee: string;
  coinCount: number;
}

/** A simple (no recovery list, 1 verification) DID owned by the wallet — amount is always 1 mojo. */
const DID_AMOUNT = 1n;

/**
 * Prepare (build, don't sign/broadcast) the CREATION of one new "simple" DID owned by this wallet
 * (no recovery list, `numVerificationsRequired = 1`) — capability parity for identity creation; a
 * DID with a real recovery list is a follow-up if a use case needs it. Funded from a SINGLE
 * wallet-owned XCH coin large enough to cover the DID amount (1 mojo) plus the fee — `Clvm.
 * createEveDid` needs that coin's id up front, so the multi-coin `Spends` auto-selection used
 * elsewhere in this wallet does not apply. Throws `NO_XCH_COINS` when the wallet holds none, or
 * `NO_SUITABLE_COIN` when no single coin covers the amount + fee (a known v1 scope limit).
 */
export async function prepareDidCreate(
  chia: DidWasm,
  chain: DidChain,
  opts: { seed: Uint8Array; fee?: bigint; gapLimit?: number },
): Promise<PreparedDidCreate> {
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));

  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  if (xchCoins.length === 0) throw new Error('NO_XCH_COINS: the wallet has no XCH to fund the DID');

  const needed = DID_AMOUNT + fee;
  const funding = [...xchCoins].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0)).find((c) => c.amount >= needed);
  if (!funding) throw new Error('NO_SUITABLE_COIN: no single coin covers the DID amount plus fee');
  const fundingPhHex = asHex(chia, funding.puzzleHash);
  const key = keyByPuzzleHash.get(fundingPhHex);
  if (!key) throw new Error('MISSING_KEY: the funding coin is not owned by this wallet');

  const clvm = new chia.Clvm();
  const created = clvm.createEveDid(funding.coinId(), funding.puzzleHash);

  const changeAmount = funding.amount - needed;
  const parentConditions: unknown[] = [...created.parentConditions];
  if (changeAmount > 0n) parentConditions.push(clvm.createCoin(funding.puzzleHash, changeAmount));
  if (fee > 0n) parentConditions.push(clvm.reserveFee(fee));
  clvm.spendStandardCoin(funding, key.pk, clvm.delegatedSpend(parentConditions));

  // Commit the eve DID's real (non-eve) lineage, re-committing to the same owner (hinted for discovery).
  clvm.spendDid(
    created.did,
    clvm.standardSpend(
      key.pk,
      clvm.delegatedSpend([clvm.createCoin(created.did.info.innerPuzzleHash(), DID_AMOUNT, clvm.alloc([funding.puzzleHash]))]),
    ),
  );

  const coinSpends = clvm.coinSpends();
  const launcherId = asHex(chia, created.did.info.launcherId);
  return {
    coinSpends,
    secretKeys: [key.sk],
    launcherId,
    summary: { launcherId, p2PuzzleHashHex: fundingPhHex, fee: fee.toString(), coinCount: coinSpends.length },
  };
}

/** A prepared (unsigned) DID transfer: coin spends + the keys to sign + the decoded summary. */
export interface PreparedDidTransfer {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: DidTransferSummary;
}
/** The decoded, tamper-resistant summary of a DID transfer for the user to approve. */
export interface DidTransferSummary {
  launcherId: string;
  recipientPuzzleHashHex: string;
  fee: string;
  coinCount: number;
}

/** Locate the wallet's DID of `launcherId` as a live wasm `Did` handle. Throws `DID_NOT_FOUND` if not held. */
export async function findOwnedDid(chia: DidWasm, chain: DidChain, clvm: DidClvm, ownedPhs: Set<string>, launcherId: string): Promise<DidObj> {
  if (!chain.coinsByHints) throw new Error('HINT_LOOKUP_UNAVAILABLE: the chain client cannot resolve hints');
  const wantId = strip0x(launcherId);
  const coins = await chain.coinsByHints([...ownedPhs]);
  for (const coin of coins) {
    const did = await reconstructOwnedDid(chia, chain, clvm, ownedPhs, coin);
    if (did && asHex(chia, did.info.launcherId) === wantId) return did;
  }
  throw new Error('DID_NOT_FOUND: the wallet does not hold this DID');
}

/**
 * Pay `fee` (if > 0) from a SEPARATE wallet-owned XCH coin, spent standalone (used by any DID op
 * whose own coin carries just 1 mojo — transfer, profile update). Returns the extra signing key
 * needed, or `[]` when no fee is being paid.
 */
export async function payFeeFromSeparateCoin(
  chain: DidChain,
  clvm: DidClvm,
  keyByPuzzleHash: Map<string, KeyringEntry>,
  keyring: KeyringEntry[],
  chiaHex: (b: Uint8Array) => string,
  fee: bigint,
): Promise<SigSecretKey[]> {
  if (fee <= 0n) return [];
  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  const feeCoin = [...xchCoins].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0)).find((c) => c.amount >= fee);
  if (!feeCoin) throw new Error('NO_XCH_COINS: insufficient XCH to pay the fee');
  const feeKey = keyByPuzzleHash.get(chiaHex(feeCoin.puzzleHash));
  if (!feeKey) throw new Error('MISSING_KEY: the fee coin is not owned by this wallet');
  const change = feeCoin.amount - fee;
  const feeConditions: unknown[] = [clvm.reserveFee(fee)];
  if (change > 0n) feeConditions.push(clvm.createCoin(feeCoin.puzzleHash, change));
  clvm.spendStandardCoin(feeCoin, feeKey.pk, clvm.delegatedSpend(feeConditions));
  return [feeKey.sk];
}

/**
 * Prepare (build, don't sign/broadcast) a transfer of the wallet's DID `launcherId` to `recipient` —
 * a new owner p2 puzzle hash, keeping the same launcher id / recovery list / verifications / metadata.
 * A `fee` (XCH), when given, is paid from a SEPARATE wallet-owned XCH coin (the DID coin itself carries
 * only 1 mojo). Returns the coin spends, the signing keys, and a decoded summary. The recipient's p2
 * puzzle hash is carried as the create-coin hint so they discover it.
 */
export async function prepareDidTransfer(
  chia: DidWasm,
  chain: DidChain,
  opts: { seed: Uint8Array; launcherId: string; recipient: string; fee?: bigint; gapLimit?: number },
): Promise<PreparedDidTransfer> {
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const clvm = new chia.Clvm();
  const did = await findOwnedDid(chia, chain, clvm, ownedPhs, opts.launcherId);

  const ownerKey = keyByPuzzleHash.get(asHex(chia, did.info.p2PuzzleHash));
  if (!ownerKey) throw new Error('MISSING_KEY: the DID owner key is not held by this wallet');

  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const newInfo = new chia.DidInfo(did.info.launcherId, did.info.recoveryListHash, did.info.numVerificationsRequired, did.info.metadata, destPuzzleHash);
  const newInnerPuzzleHash = newInfo.innerPuzzleHash();

  const feeKeys = await payFeeFromSeparateCoin(chain, clvm, keyByPuzzleHash, keyring, (b) => asHex(chia, b), fee);
  const secretKeys: SigSecretKey[] = [ownerKey.sk, ...feeKeys];

  clvm.spendDid(
    did,
    clvm.standardSpend(ownerKey.pk, clvm.delegatedSpend([clvm.createCoin(newInnerPuzzleHash, DID_AMOUNT, clvm.alloc([destPuzzleHash]))])),
  );

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys,
    summary: {
      launcherId: strip0x(opts.launcherId),
      recipientPuzzleHashHex: asHex(chia, destPuzzleHash),
      fee: fee.toString(),
      coinCount: coinSpends.length,
    },
  };
}

/** A prepared (unsigned) DID profile update: coin spends + the keys to sign + the decoded summary. */
export interface PreparedDidProfileUpdate {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: DidProfileUpdateSummary;
}
/** The decoded, tamper-resistant summary of a DID profile update for the user to approve. */
export interface DidProfileUpdateSummary {
  launcherId: string;
  profileName: string;
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) a PROFILE update of the wallet's DID `launcherId` — sets its
 * on-chain `metadata` to a plain UTF-8 `profileName` atom (the human-facing name shown for this
 * identity), keeping the same launcher id / owner / recovery list / verifications. A `fee` (XCH),
 * when given, is paid from a SEPARATE wallet-owned XCH coin (the DID coin itself carries only 1
 * mojo). No `TransferNft`/DID-cooperation handshake is involved.
 *
 * TWO chained DID spends (a same-bundle ephemeral hop), NOT one — confirmed against the
 * chia-wallet-sdk driver (`Did::parse_child`, xch-dev/chia-wallet-sdk
 * crates/chia-sdk-driver/src/primitives/did.rs): a chain rescan reconstructs a DID's `metadata` from
 * its PARENT coin's OWN curried value — NEVER from the create-coin hint (unlike `p2PuzzleHash`,
 * which a rescan reads directly off the hint, so {@link prepareDidTransfer} needs only one spend).
 * A single metadata-changing spend is therefore invisible to `listDids` immediately afterward: the
 * new coin's parent (the coin we just spent) still carries the OLD metadata in ITS OWN reveal. The
 * fix (documented on `Did::update` as "settle the DID's updated metadata and make it parseable by
 * wallets"): spend once more, self-to-self, through an ephemeral intermediate coin that already
 * carries the NEW metadata — a rescan then reads that ephemeral coin as the final coin's parent and
 * recovers the right value. `did.child(p2PuzzleHash, metadata)` computes the expected post-spend
 * `Did` (coin + lineage proof) exactly like `Clvm.createEveDid`'s eve commit does, so the intermediate
 * hop is spendable in the SAME `Clvm` without a chain round-trip.
 */
export async function prepareDidProfileUpdate(
  chia: DidWasm,
  chain: DidChain,
  opts: { seed: Uint8Array; launcherId: string; profileName: string; fee?: bigint; gapLimit?: number },
): Promise<PreparedDidProfileUpdate> {
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  const clvm = new chia.Clvm();
  const did = await findOwnedDid(chia, chain, clvm, ownedPhs, opts.launcherId);

  const ownerKey = keyByPuzzleHash.get(asHex(chia, did.info.p2PuzzleHash));
  if (!ownerKey) throw new Error('MISSING_KEY: the DID owner key is not held by this wallet');

  const newMetadata = clvm.alloc(opts.profileName);
  const intermediate = did.child(did.info.p2PuzzleHash, newMetadata);
  const newInnerPuzzleHash = intermediate.info.innerPuzzleHash();
  const selfSpend = (): unknown =>
    clvm.standardSpend(ownerKey.pk, clvm.delegatedSpend([clvm.createCoin(newInnerPuzzleHash, DID_AMOUNT, clvm.alloc([did.info.p2PuzzleHash]))]));

  const feeKeys = await payFeeFromSeparateCoin(chain, clvm, keyByPuzzleHash, keyring, (b) => asHex(chia, b), fee);
  const secretKeys: SigSecretKey[] = [ownerKey.sk, ...feeKeys];

  clvm.spendDid(did, selfSpend()); // hop 1: commits the new metadata into the ephemeral coin's OWN reveal
  clvm.spendDid(intermediate, selfSpend()); // hop 2 ("settle"): re-spend it so a rescan sees hop 1 as a parent

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys,
    summary: {
      launcherId: strip0x(opts.launcherId),
      profileName: opts.profileName,
      fee: fee.toString(),
      coinCount: coinSpends.length,
    },
  };
}
