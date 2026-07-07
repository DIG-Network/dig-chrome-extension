/**
 * Self-custody trade offers (§6 Trade) — MAKE / INSPECT / TAKE / CANCEL of Chia offers, assembled
 * from `chia-wallet-sdk-wasm` primitives to match the canonical `chia-sdk-driver` offer construction
 * byte-for-byte (so offers interoperate with Sage / dexie). Runs in the offscreen vault (holds the
 * seed). Pure (injected wasm + chain); every money path is proven consensus-valid by a two-party
 * simulator settlement test (offers.test.ts) — nothing is broadcast in CI.
 *
 * Offer model (from chia-sdk-driver `offers/offer.rs` + `offers/requested_payments.rs`):
 *   - The maker's real coins are spent into the SETTLEMENT puzzle (the OFFERED side) and the maker's
 *     spend ASSERTS a puzzle announcement for each REQUESTED notarized payment (it never FUNDS the
 *     requested side — so there is no self-fund leak; the offered coin keeps full change).
 *   - The REQUESTED payments are carried as "phantom" coin spends appended to the bundle: a coin with
 *     a ZERO parent + amount 0, whose puzzle is the settlement puzzle (XCH) or the CAT-wrapped
 *     settlement puzzle (CAT — encoding the asset id) and whose solution is the notarized payments.
 *     `from_spend_bundle` distinguishes them by `parent == 0` and DROPS them when taking.
 *   - TAKE adds the offered settlement coins (the taker receives them) + the taker's own coins to
 *     fund the requested payments, applies the requested settle actions (which create the requested
 *     payments to the maker + the matching announcements), and concatenates the maker's REAL coin
 *     spends with the taker's spends into one aggregated bundle.
 *   - CANCEL re-spends the maker's original offered coins back to self, invalidating the offer.
 *
 * v1 supported a single offered asset and a single requested asset, each XCH or a CAT. v2 (#94) adds
 * NFT as an OFFERED asset (selling a self-custody NFT for XCH/CAT), including CHIP-0011 royalty:
 *   - The maker's NFT spend to settlement carries an `Action.updateNft(nftId, [], TransferNftById(
 *     undefined, [TradePrice(requestedAmount, requestedAssetSettlementPuzzleHash)]))` BEFORE the
 *     `Action.send` claiming it into settlement — this is the CHIP-0011 "sale" signal; the NFT's own
 *     ownership-layer transfer program (curried at mint time) reacts to it by emitting the royalty
 *     ASSERT_PUZZLE_ANNOUNCEMENT automatically (no JS-side puzzle logic needed — verified against the
 *     reference `sage-wallet` offer builder, `make_offer.rs`).
 *   - The taker satisfies that assert with an EXTRA `Action.settle(requestedAssetId, royaltyNp)` where
 *     `royaltyNp = NotarizedPayment(nftLauncherId, [Payment(royaltyPuzzleHash, floor(tradePrice *
 *     royaltyBasisPoints / 10000), memos:[royaltyPuzzleHash])])` — the royalty nonce is the NFT's OWN
 *     launcher id, a DIFFERENT value from the offer's `Offer::nonce` (sorted offered-coin-ids tree hash).
 *   - Requesting a SPECIFIC NFT (buying, rather than selling) needs the maker to know that NFT's full
 *     on-chain state up front (metadata/owner/royalty) to build its phantom carrier's 3-layer puzzle
 *     reveal — this needs a "read any NFT by launcher id" chain capability this wallet doesn't have
 *     yet (only owned-NFT hint-scan), so it is a tracked follow-up, not implemented here.
 *   - **DID is NOT an offer asset** — verified against BOTH the reference `chia-wallet-sdk` driver
 *     (`OfferCoins`/`RequestedPayments` in `offers/*.rs`) and Sage wallet's offer builder: neither
 *     models a `dids` leg. A DID has no CHIP-0011-style royalty and no settlement-puzzle-hash
 *     convention any wallet's offer parser recognizes, so a hand-rolled "DID offer" would produce an
 *     offer string NO OTHER WALLET could take — a capability-parity / interop dead end, not built.
 */

import { buildKeyring, reconstructCats, type SendFlowWasm } from '@/offscreen/sendFlow';
import { signCoinSpends, MAINNET_AGG_SIG_ME, type SigningWasm, type SigCoinSpend } from '@/offscreen/signing';
import { findOwnedNft, type NftWasm, type NftClvm } from '@/offscreen/nfts';
import type { ChainClient, ChainSpendBundle } from '@/offscreen/chain';

const MAX_COST = 11_000_000_000n;
const ZERO32 = new Uint8Array(32);
const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/**
 * An asset side of an offer: native XCH, a CAT (by TAIL/asset id hex), or an NFT (by launcher id
 * hex — OFFERED side only, v2 §94; see the module doc for why DID is not an offer asset and why a
 * REQUESTED NFT leg is a follow-up).
 */
export type OfferAsset = { kind: 'xch' } | { kind: 'cat'; assetId: string } | { kind: 'nft'; launcherId: string };

/** One side of a trade: the asset + amount in base units. */
export interface OfferLeg {
  asset: OfferAsset;
  amount: bigint;
}

// ── Minimal structural wasm surfaces (focused casts, per sendFlow's pattern) ──────────────────────
interface WasmProgram {
  serialize(): Uint8Array;
  treeHash(): Uint8Array;
  run(solution: WasmProgram, maxCost: bigint, mempoolMode: boolean): { value: WasmProgram };
  toList(): WasmProgram[] | undefined;
  toAtom(): Uint8Array | undefined;
  uncurry(): { program: WasmProgram; args: WasmProgram[] } | undefined;
  curry(args: WasmProgram[]): WasmProgram;
  parseCreateCoin(): { puzzleHash: Uint8Array; amount: bigint } | undefined;
  parseNotarizedPayment(): WasmNotarizedPayment | undefined;
  /** The singleton `Puzzle` view — used to reconstruct an offered NFT via `parseChildNft` (§94). */
  puzzle(): { parseChildNft(parentCoin: WasmCoin, parentSolution: WasmProgram): WasmNft | undefined };
}
/** A reconstructed NFT (mirrors `nfts.ts`'s `NftObj`, focused to what the offer engine needs). */
interface WasmNft {
  coin: WasmCoin;
  info: {
    launcherId: Uint8Array;
    p2PuzzleHash: Uint8Array;
    royaltyPuzzleHash: Uint8Array;
    royaltyBasisPoints: number;
  };
}
interface WasmSpend {
  puzzle: WasmProgram;
  solution: WasmProgram;
}
interface WasmCoin {
  coinId(): Uint8Array;
  parentCoinInfo: Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
}
interface WasmCoinSpend {
  coin: WasmCoin;
  puzzleReveal: Uint8Array;
  solution: Uint8Array;
}
interface WasmNotarizedPayment {
  nonce: Uint8Array;
  payments: { puzzleHash: Uint8Array; amount: bigint }[];
}
interface WasmClvm {
  deserialize(bytes: Uint8Array): WasmProgram;
  alloc(value: unknown): WasmProgram;
  atom(value: Uint8Array): WasmProgram;
  list(value: WasmProgram[]): WasmProgram;
  delegatedSpend(conditions: WasmProgram[]): WasmSpend;
  standardSpend(syntheticKey: unknown, spend: WasmSpend): WasmSpend;
  settlementSpend(notarizedPayments: WasmNotarizedPayment[]): WasmSpend;
  settlementPayment(): WasmProgram;
  catPuzzle(): WasmProgram;
  assertPuzzleAnnouncement(announcementId: Uint8Array): WasmProgram;
  offerSettlementCats(offer: unknown, assetId: Uint8Array): WasmCat[];
  coinSpends(): SigCoinSpend[];
}
interface WasmCat {
  coin: WasmCoin;
  info: { assetId: Uint8Array; p2PuzzleHash: Uint8Array };
}
interface WasmPendingSpend {
  coin(): WasmCoin;
  p2PuzzleHash(): Uint8Array;
  conditions(): WasmProgram[];
}
interface WasmFinished {
  pendingSpends(): WasmPendingSpend[];
  insert(coinId: Uint8Array, spend: WasmSpend): void;
  spend(): unknown;
}
interface WasmSpends {
  addXch(coin: WasmCoin): void;
  addCat(cat: WasmCat): void;
  addNft(nft: WasmNft): void;
  addRequiredCondition(condition: WasmProgram): void;
  apply(actions: unknown[]): unknown;
  prepare(deltas: unknown): WasmFinished;
}
interface WasmDecodedOffer {
  coinSpends: WasmCoinSpend[];
  aggregatedSignature: unknown;
}

/**
 * The full wasm surface the offer engine needs. Standalone (NOT `extends SendFlowWasm`) because the
 * offer engine types `Clvm`/`Spends`/`Action`/`Id` more richly than the send flow; the shared
 * derivation/signing helpers receive a focused cast (`as unknown as SendFlowWasm`/`SigningWasm`).
 */
export interface OfferWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  catPuzzleHash(assetId: Uint8Array, innerPuzzleHash: Uint8Array): Uint8Array;
  sha256(value: Uint8Array): Uint8Array;
  encodeOffer(bundle: unknown): string;
  decodeOffer(offer: string): WasmDecodedOffer;
  Clvm: new () => WasmClvm;
  Spends: new (clvm: WasmClvm, changePuzzleHash: Uint8Array) => WasmSpends;
  Coin: new (parent: Uint8Array, puzzleHash: Uint8Array, amount: bigint) => WasmCoin;
  CoinSpend: new (coin: WasmCoin, puzzleReveal: Uint8Array, solution: Uint8Array) => WasmCoinSpend;
  NotarizedPayment: new (nonce: Uint8Array, payments: unknown[]) => WasmNotarizedPayment;
  Payment: new (puzzleHash: Uint8Array, amount: bigint, memos: WasmProgram | undefined) => unknown;
  /** CHIP-0011 trade price: what a requested/offered asset amount is worth, for royalty math (§94). */
  TradePrice: new (amount: bigint, puzzleHash: Uint8Array) => unknown;
  /** The `-10` NFT ownership-transfer condition reveal driving `Action.updateNft` (§94). */
  TransferNftById: new (ownerId: unknown | undefined, tradePrices: unknown[]) => unknown;
  Action: {
    send(id: unknown, puzzleHash: Uint8Array, amount: bigint, memos: unknown): unknown;
    fee(amount: bigint): unknown;
    settle(id: unknown, np: WasmNotarizedPayment): unknown;
    /** Emits the CHIP-0011 "sale" signal (`TransferNftById`) on an NFT's own pending spend (§94). */
    updateNft(id: unknown, metadataUpdateSpends: unknown[], transfer?: unknown): unknown;
  };
  Id: { xch(): unknown; existing(assetId: Uint8Array): unknown };
  Signature: { aggregate(signatures: unknown[]): unknown };
  SpendBundle: new (coinSpends: SigCoinSpend[], signature: unknown) => ChainSpendBundle;
  Constants: { settlementPaymentHash(): Uint8Array; catPuzzleHash(): Uint8Array };
}

const asHex = (chia: OfferWasm, b: Uint8Array): string => strip0x(chia.toHex(b));
const bytes = (chia: OfferWasm, hex: string): Uint8Array => chia.fromHex(strip0x(hex));

/** Compare two byte arrays lexicographically (for the ascending coin-id sort in the nonce). */
function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Offer nonce = tree_hash of the ASCENDING-sorted offered coin ids (chia-sdk `Offer::nonce`). */
export function offerNonce(clvm: WasmClvm, coinIds: Uint8Array[]): Uint8Array {
  const sorted = [...coinIds].sort(byteCompare);
  return clvm.list(sorted.map((id) => clvm.atom(id))).treeHash();
}

/** A fungible (non-singleton) offer asset — XCH or a CAT; what a settlement puzzle hash is defined for. */
type FungibleAsset = { kind: 'xch' } | { kind: 'cat'; assetId: string };

/** The settlement puzzle hash for a fungible asset: SETTLE for XCH, CAT-wrapped SETTLE for a CAT. */
function settlementPuzzleHash(chia: OfferWasm, asset: FungibleAsset): Uint8Array {
  const settle = chia.Constants.settlementPaymentHash();
  return asset.kind === 'xch' ? settle : chia.catPuzzleHash(bytes(chia, asset.assetId), settle);
}

/** The payment-assertion announcement id = sha256(settlementPuzzleHash ‖ treeHash(notarizedPayment)). */
function paymentAssertionId(chia: OfferWasm, clvm: WasmClvm, asset: FungibleAsset, np: WasmNotarizedPayment): Uint8Array {
  const ph = settlementPuzzleHash(chia, asset);
  const npHash = clvm.alloc(np).treeHash();
  const buf = new Uint8Array(ph.length + npHash.length);
  buf.set(ph, 0);
  buf.set(npHash, ph.length);
  return chia.sha256(buf);
}

/** Build the phantom requested-payment carrier coin spend (ZERO parent, amount 0). */
function buildPhantomCarrier(chia: OfferWasm, asset: FungibleAsset, np: WasmNotarizedPayment): WasmCoinSpend {
  const clvm = new chia.Clvm();
  const settlementSol = clvm.settlementSpend([np]).solution;
  const ph = settlementPuzzleHash(chia, asset);
  let reveal: Uint8Array;
  if (asset.kind === 'xch') {
    reveal = clvm.settlementPayment().serialize();
  } else {
    const curried = clvm.catPuzzle().curry([
      clvm.atom(chia.Constants.catPuzzleHash()),
      clvm.atom(bytes(chia, asset.assetId)),
      clvm.settlementPayment(),
    ]);
    reveal = curried.serialize();
  }
  return new chia.CoinSpend(new chia.Coin(ZERO32, ph, 0n), reveal, settlementSol.serialize());
}

/** A notarized payment paying `puzzleHash` `amount`, notarized with `nonce`. */
function notarizedPayment(chia: OfferWasm, nonce: Uint8Array, puzzleHash: Uint8Array, amount: bigint): WasmNotarizedPayment {
  return new chia.NotarizedPayment(nonce, [new chia.Payment(puzzleHash, amount, undefined)]);
}

/**
 * The CHIP-0011 royalty payment: `floor(tradePrice * royaltyBasisPoints / 10000)` mojos, paid to
 * `royaltyPuzzleHash`, notarized with the NFT's OWN launcher id (NOT the offer's nonce — a royalty
 * payment stands alone, matched by the NFT ownership layer's own automatically-emitted assert; see
 * the module doc). `undefined` when the royalty rounds to 0 (nothing to pay). Hints the royalty
 * address in `memos` (the on-chain convention every wallet/marketplace expects for a royalty coin).
 */
function royaltyPayment(
  chia: OfferWasm,
  clvm: WasmClvm,
  nftLauncherId: Uint8Array,
  royaltyPuzzleHash: Uint8Array,
  royaltyBasisPoints: number,
  tradePrice: bigint,
): WasmNotarizedPayment | undefined {
  const amount = (tradePrice * BigInt(royaltyBasisPoints)) / 10_000n;
  if (amount <= 0n) return undefined;
  const memos = clvm.alloc([royaltyPuzzleHash]);
  return new chia.NotarizedPayment(nftLauncherId, [new chia.Payment(royaltyPuzzleHash, amount, memos)]);
}

/**
 * Try to reconstruct an OFFERED NFT from one of the maker's REAL coin spends: `parseChildNft`
 * reconstructs the child exactly like `nfts.ts`'s owned-NFT scan, except here "owned" is replaced by
 * "its new p2 puzzle hash is the settlement puzzle" (the maker sent it into escrow, not to a wallet).
 * Returns `null` for every non-NFT real spend (XCH/CAT coins have no `puzzle().parseChildNft`, or it
 * returns `undefined`, or the child's p2 isn't the settlement hash).
 */
function parseOfferedNft(chia: OfferWasm, clvm: WasmClvm, cs: WasmCoinSpend): WasmNft | null {
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());
  let nft: WasmNft | undefined;
  try {
    nft = clvm.deserialize(cs.puzzleReveal).puzzle().parseChildNft(cs.coin, clvm.deserialize(cs.solution));
  } catch {
    return null; // not a singleton puzzle at all
  }
  if (!nft || asHex(chia, nft.info.p2PuzzleHash) !== settleHex) return null;
  return nft;
}

/** Provide the inner spend for a driver pending spend (settlement coins → pay `receivePh`; else standard). */
function insertInnerSpends(
  chia: OfferWasm,
  clvm: WasmClvm,
  fin: WasmFinished,
  keyByPuzzleHash: Map<string, { pk: unknown }>,
  settleHex: string,
  nonce: Uint8Array,
  receivePh: Uint8Array,
): void {
  for (const ps of fin.pendingSpends()) {
    const p2 = asHex(chia, ps.p2PuzzleHash());
    if (p2 === settleHex) {
      // An offered settlement coin the taker is claiming → pay it to the taker's receive address.
      fin.insert(ps.coin().coinId(), clvm.settlementSpend([notarizedPayment(chia, nonce, receivePh, ps.coin().amount)]));
    } else {
      const key = keyByPuzzleHash.get(p2);
      if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
      fin.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
    }
  }
}

/** A decoded, human-readable view of an offer: what is offered vs requested (base units). */
export interface OfferSummary {
  offered: OfferLeg[];
  requested: { asset: OfferAsset; amount: bigint; toPuzzleHashHex: string }[];
}

/** The result of building an offer: the shareable `offer1…` string + the two-sided summary. */
export interface MadeOffer {
  offer: string;
  summary: OfferSummary;
}

/**
 * MAKE an offer: spend the wallet's OFFERED coins into the settlement puzzle, assert the REQUESTED
 * payment announcement (never funding it), and append the phantom requested-payment carrier. Returns
 * the encoded `offer1…` string. Does NOT broadcast — an offer is only a promise until taken.
 */
export async function makeOffer(
  chia: OfferWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; offered: OfferLeg; requested: OfferLeg; fee?: bigint; activeIndex?: number; additionalDataHex?: string },
): Promise<MadeOffer> {
  if (opts.offered.asset.kind === opts.requested.asset.kind && opts.offered.asset.kind === 'xch') {
    throw new Error('SAME_ASSET: cannot trade XCH for XCH');
  }
  if (opts.offered.asset.kind === 'cat' && opts.requested.asset.kind === 'cat' && opts.offered.asset.assetId === opts.requested.asset.assetId) {
    throw new Error('SAME_ASSET: cannot trade a token for itself');
  }
  if (opts.requested.asset.kind === 'nft') {
    // Requesting a SPECIFIC NFT needs its full on-chain state (metadata/owner/royalty) known up
    // front to build its phantom carrier's 3-layer puzzle reveal — a "read any NFT by launcher id"
    // capability this wallet doesn't have yet (only owned-NFT hint-scan). Tracked follow-up.
    throw new Error('UNSUPPORTED_REQUEST: requesting a specific NFT is not yet supported — offer it instead');
  }
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex); // requested payment + change → index-0
  const settleHash = chia.Constants.settlementPaymentHash();
  const requestedAsset: FungibleAsset = opts.requested.asset;

  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, receivePh);

  // Add the OFFERED asset (+ XCH to cover the fee) and record its coin id(s) for the nonce.
  const offeredCoinIds: Uint8Array[] = [];
  let offeredNft: WasmNft | undefined;
  if (opts.offered.asset.kind === 'xch') {
    const xch = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
    for (const c of xch) {
      spends.addXch(c as unknown as WasmCoin);
      offeredCoinIds.push((c as unknown as WasmCoin).coinId());
    }
  } else if (opts.offered.asset.kind === 'cat') {
    const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, opts.offered.asset.assetId)) as unknown as WasmCat[];
    if (cats.length === 0) throw new Error('NO_CAT_COINS: the wallet holds none of this token');
    for (const c of cats) {
      spends.addCat(c);
      offeredCoinIds.push(c.coin.coinId());
    }
    if (fee > 0n) for (const c of await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex))) spends.addXch(c as unknown as WasmCoin);
  } else {
    offeredNft = (await findOwnedNft(
      chia as unknown as NftWasm,
      chain,
      clvm as unknown as NftClvm,
      keyring,
      opts.offered.asset.launcherId,
    )) as unknown as WasmNft;
    spends.addNft(offeredNft);
    offeredCoinIds.push(offeredNft.coin.coinId());
    if (fee > 0n) for (const c of await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex))) spends.addXch(c as unknown as WasmCoin);
  }
  const offeredAmount = opts.offered.asset.kind === 'nft' ? 1n : opts.offered.amount;

  const nonce = offerNonce(clvm, offeredCoinIds);
  const reqNp = notarizedPayment(chia, nonce, receivePh, opts.requested.amount);

  const actions: unknown[] = [];
  if (opts.offered.asset.kind === 'nft') {
    // CHIP-0011 royalty (§94): declare the sale's trade price BEFORE claiming the NFT into
    // settlement, so the ownership layer's transfer program emits the royalty assert automatically.
    const nftId = chia.Id.existing(bytes(chia, opts.offered.asset.launcherId));
    if (offeredNft!.info.royaltyBasisPoints > 0) {
      const tradePrice = new chia.TradePrice(opts.requested.amount, settlementPuzzleHash(chia, requestedAsset));
      actions.push(chia.Action.updateNft(nftId, [], new chia.TransferNftById(undefined, [tradePrice])));
    }
    actions.push(chia.Action.send(nftId, settleHash, 1n, undefined));
  } else {
    const offeredId = opts.offered.asset.kind === 'xch' ? chia.Id.xch() : chia.Id.existing(bytes(chia, opts.offered.asset.assetId));
    actions.push(chia.Action.send(offeredId, settleHash, offeredAmount, undefined));
  }
  if (fee > 0n) actions.push(chia.Action.fee(fee));
  const deltas = spends.apply(actions);
  spends.addRequiredCondition(clvm.assertPuzzleAnnouncement(paymentAssertionId(chia, clvm, requestedAsset, reqNp)));

  const fin = spends.prepare(deltas);
  for (const ps of fin.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    fin.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  fin.spend();
  const realCoinSpends = clvm.coinSpends();
  const sig = signCoinSpends(chia as unknown as SigningWasm, realCoinSpends, keyring.map((k) => k.sk), additionalData);

  const phantom = buildPhantomCarrier(chia, requestedAsset, reqNp);
  const bundle = new chia.SpendBundle([...realCoinSpends, phantom as unknown as SigCoinSpend], sig);
  const offer = chia.encodeOffer(bundle);
  return {
    offer,
    summary: {
      offered: [{ asset: opts.offered.asset, amount: offeredAmount }],
      requested: [{ asset: opts.requested.asset, amount: opts.requested.amount, toPuzzleHashHex: asHex(chia, receivePh) }],
    },
  };
}

/** Split decoded coin spends into the maker's REAL coins vs the phantom requested carriers (ZERO parent). */
function splitDecoded(chia: OfferWasm, decoded: WasmDecodedOffer): { real: WasmCoinSpend[]; phantom: WasmCoinSpend[] } {
  const zero = asHex(chia, ZERO32);
  const real: WasmCoinSpend[] = [];
  const phantom: WasmCoinSpend[] = [];
  for (const cs of decoded.coinSpends) (asHex(chia, cs.coin.parentCoinInfo) === zero ? phantom : real).push(cs);
  return { real, phantom };
}

/** Parse the requested payments (asset + notarized payment) from the phantom carriers. */
function parseRequested(
  chia: OfferWasm,
  clvm: WasmClvm,
  phantom: WasmCoinSpend[],
): { asset: OfferAsset; np: WasmNotarizedPayment }[] {
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());
  const out: { asset: OfferAsset; np: WasmNotarizedPayment }[] = [];
  for (const cs of phantom) {
    let asset: OfferAsset = { kind: 'xch' };
    if (asHex(chia, cs.coin.puzzleHash) !== settleHex) {
      const uncurried = clvm.deserialize(cs.puzzleReveal).uncurry();
      const assetId = uncurried?.args?.[1]?.toAtom();
      if (assetId) asset = { kind: 'cat', assetId: asHex(chia, assetId) };
    }
    const sol = clvm.deserialize(cs.solution);
    const nps = sol.toList() ?? [];
    for (const npProg of nps) {
      const np = npProg.parseNotarizedPayment();
      if (np) out.push({ asset, np });
    }
  }
  return out;
}

/** Reconstruct the OFFERED settlement coins (what the taker receives) from the maker's real spends. */
function offeredSettlementLegs(
  chia: OfferWasm,
  clvm: WasmClvm,
  decoded: WasmDecodedOffer,
  real: WasmCoinSpend[],
): { xchCoins: WasmCoin[]; cats: WasmCat[]; nft?: WasmNft; legs: OfferLeg[] } {
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());
  const xchCoins: WasmCoin[] = [];
  const legs: OfferLeg[] = [];
  const catAssetIds = new Set<string>();
  let xchTotal = 0n;
  let nft: WasmNft | undefined;
  for (const cs of real) {
    const offeredNft = parseOfferedNft(chia, clvm, cs);
    if (offeredNft) {
      nft = offeredNft; // v1: at most one offered NFT per offer (single-offered-asset model)
      continue;
    }
    const conds = clvm.deserialize(cs.puzzleReveal).run(clvm.deserialize(cs.solution), MAX_COST, false).value.toList() ?? [];
    const outerIsCat = asHex(chia, cs.coin.puzzleHash) !== settleHex && looksLikeCat(chia, clvm, cs);
    for (const c of conds) {
      const cc = c.parseCreateCoin();
      if (!cc) continue;
      const outPh = asHex(chia, cc.puzzleHash);
      if (!outerIsCat && outPh === settleHex && cc.amount > 0n) {
        xchCoins.push(new chia.Coin(cs.coin.coinId(), chia.Constants.settlementPaymentHash(), cc.amount));
        xchTotal += cc.amount;
      } else if (outerIsCat && cc.amount > 0n) {
        // CAT settlement outputs are detected below via offerSettlementCats; record the asset id.
        const assetId = catAssetIdOf(chia, clvm, cs);
        if (assetId) catAssetIds.add(assetId);
      }
    }
  }
  if (xchTotal > 0n) legs.push({ asset: { kind: 'xch' }, amount: xchTotal });
  const cats: WasmCat[] = [];
  for (const assetId of catAssetIds) {
    const found = clvm.offerSettlementCats(decoded, bytes(chia, assetId));
    let amt = 0n;
    for (const cat of found) {
      cats.push(cat);
      amt += cat.coin.amount;
    }
    if (amt > 0n) legs.push({ asset: { kind: 'cat', assetId }, amount: amt });
  }
  if (nft) legs.push({ asset: { kind: 'nft', launcherId: asHex(chia, nft.info.launcherId) }, amount: 1n });
  return { xchCoins, cats, nft, legs };
}

/** True if a maker coin spend is a CAT coin (its puzzle uncurries to the CAT mod). */
function looksLikeCat(chia: OfferWasm, clvm: WasmClvm, cs: WasmCoinSpend): boolean {
  return catAssetIdOf(chia, clvm, cs) !== null;
}

/** The asset id of a CAT coin spend (from its puzzle's curry args), or null if not a CAT. */
function catAssetIdOf(chia: OfferWasm, clvm: WasmClvm, cs: WasmCoinSpend): string | null {
  const uncurried = clvm.deserialize(cs.puzzleReveal).uncurry();
  if (!uncurried || uncurried.args.length < 3) return null;
  const modHash = uncurried.args[0]?.toAtom();
  if (!modHash || asHex(chia, modHash) !== asHex(chia, chia.Constants.catPuzzleHash())) return null;
  const assetId = uncurried.args[1]?.toAtom();
  return assetId ? asHex(chia, assetId) : null;
}

/** INSPECT an offer: decode + report the two-sided (offered vs requested) summary. Read-only. */
export function inspectOffer(chia: OfferWasm, offerStr: string): OfferSummary {
  const decoded = chia.decodeOffer(offerStr.trim());
  const clvm = new chia.Clvm();
  const { real, phantom } = splitDecoded(chia, decoded);
  const requested = parseRequested(chia, clvm, phantom).map((r) => ({
    asset: r.asset,
    amount: r.np.payments.reduce((s, p) => s + p.amount, 0n),
    toPuzzleHashHex: r.np.payments[0] ? asHex(chia, r.np.payments[0].puzzleHash) : '',
  }));
  const { legs } = offeredSettlementLegs(chia, clvm, decoded, real);
  return { offered: legs, requested };
}

/** A prepared, signed trade bundle ready to broadcast (take or cancel) + its summary. */
export interface PreparedTrade {
  bundle: ChainSpendBundle;
  summary: OfferSummary;
  inputCoinId: string;
}

/**
 * TAKE an offer: receive the offered settlement coins + fund the requested payments from the wallet,
 * then aggregate with the maker's spends into one bundle. Does NOT broadcast (the vault's confirm
 * step does, on user approval). Fee is paid by the taker.
 */
export async function takeOffer(
  chia: OfferWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; offerStr: string; fee?: bigint; activeIndex?: number; additionalDataHex?: string },
): Promise<PreparedTrade> {
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const decoded = chia.decodeOffer(opts.offerStr.trim());
  const clvm = new chia.Clvm();
  const { real, phantom } = splitDecoded(chia, decoded);
  const requested = parseRequested(chia, clvm, phantom);
  const offered = offeredSettlementLegs(chia, clvm, decoded, real);

  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex);
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());

  if (requested.some((r) => r.asset.kind === 'nft')) {
    // Fulfilling a request for a SPECIFIC NFT (giving up one of the taker's own NFTs) is the same
    // "read/build an unowned NFT's 3-layer reveal" gap as requesting one — not yet supported.
    throw new Error('UNSUPPORTED_REQUEST: taking an offer that requests a specific NFT is not yet supported');
  }

  const spends = new chia.Spends(clvm, receivePh);
  // Offered coins → the taker receives them.
  for (const c of offered.xchCoins) spends.addXch(c);
  for (const c of offered.cats) spends.addCat(c);
  if (offered.nft) spends.addNft(offered.nft);
  // Fund the requested payments (+ royalty, when the offered NFT carries one) from the wallet.
  const xch = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  for (const c of xch) spends.addXch(c as unknown as WasmCoin);
  for (const req of requested) {
    if (req.asset.kind === 'cat') {
      const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, req.asset.assetId)) as unknown as WasmCat[];
      if (cats.length === 0) throw new Error('NO_CAT_COINS: the wallet cannot fund a requested token');
      for (const c of cats) spends.addCat(c);
    }
  }

  const requestedIdOf = (asset: FungibleAsset): unknown => (asset.kind === 'xch' ? chia.Id.xch() : chia.Id.existing(bytes(chia, asset.assetId)));
  const actions: unknown[] = requested.map((req) => chia.Action.settle(requestedIdOf(req.asset as FungibleAsset), req.np));
  if (offered.nft) {
    // No explicit claim action needed: like the offered XCH/CAT coins (added but never targeted by an
    // Action either), an added asset's fully-unconsumed pooled value returns automatically as change
    // to `changePuzzleHash` (=receivePh) — proven by the existing DIR-2 XCH/CAT test. Only the ROYALTY
    // (a genuinely NEW outgoing payment) needs an explicit action.
    const firstRequested = requested[0];
    if (firstRequested) {
      const tradePrice = firstRequested.np.payments.reduce((s, p) => s + p.amount, 0n);
      const royaltyNp = royaltyPayment(
        chia,
        clvm,
        offered.nft.info.launcherId,
        offered.nft.info.royaltyPuzzleHash,
        offered.nft.info.royaltyBasisPoints,
        tradePrice,
      );
      if (royaltyNp) actions.push(chia.Action.settle(requestedIdOf(firstRequested.asset as FungibleAsset), royaltyNp));
    }
  }
  if (fee > 0n) actions.push(chia.Action.fee(fee));
  const deltas = spends.apply(actions);
  const offeredCoinIdsForNonce = [...offered.xchCoins, ...offered.cats.map((c) => c.coin), ...(offered.nft ? [offered.nft.coin] : [])];
  const takeNonce = offerNonce(clvm, offeredCoinIdsForNonce.map((c) => c.coinId()));
  const fin = spends.prepare(deltas);
  insertInnerSpends(chia, clvm, fin, keyByPuzzleHash, settleHex, takeNonce, receivePh);
  fin.spend();

  const takerSpends = clvm.coinSpends();
  const takerSig = signCoinSpends(chia as unknown as SigningWasm, takerSpends, keyring.map((k) => k.sk), additionalData);
  const finalSig = chia.Signature.aggregate([decoded.aggregatedSignature, takerSig]);
  const allSpends = [...(real as unknown as SigCoinSpend[]), ...takerSpends];
  const bundle = new chia.SpendBundle(allSpends, finalSig);

  return {
    bundle,
    summary: { offered: offered.legs, requested: requested.map((r) => ({ asset: r.asset, amount: r.np.payments.reduce((s, p) => s + p.amount, 0n), toPuzzleHashHex: r.np.payments[0] ? asHex(chia, r.np.payments[0].puzzleHash) : '' })) },
    inputCoinId: takerSpends[0] ? asHex(chia, takerSpends[0].coin.coinId()) : '',
  };
}

/**
 * CANCEL an offer you made: re-spend the maker's original offered coins back to your own address,
 * invalidating the offer (its settlement coins can no longer be created). Does NOT broadcast.
 */
export async function cancelOffer(
  chia: OfferWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; offerStr: string; fee?: bigint; activeIndex?: number; additionalDataHex?: string },
): Promise<PreparedTrade> {
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const decoded = chia.decodeOffer(opts.offerStr.trim());
  const clvm = new chia.Clvm();
  const { real } = splitDecoded(chia, decoded);

  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex);
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));

  // The maker's original coins = the real spends' input coins (they belong to this wallet). An
  // offered NFT is re-fetched FRESH via findOwnedNft rather than reused from the (never-broadcast)
  // offer spend — the offer transaction never landed on-chain, so the NFT still sits, unspent, at its
  // pre-offer location; only a live chain read gives a spendable handle to it.
  const spends = new chia.Spends(clvm, receivePh);
  const catAssetIds = new Set<string>();
  let addedXch = false;
  let cancelledNftLauncherId: string | null = null;
  for (const cs of real) {
    const p2 = asHex(chia, cs.coin.puzzleHash);
    if (ownedPhs.has(p2)) {
      spends.addXch(cs.coin);
      addedXch = true;
      continue;
    }
    const assetId = catAssetIdOf(chia, clvm, cs);
    if (assetId) {
      catAssetIds.add(assetId);
      continue;
    }
    const offeredNft = parseOfferedNft(chia, clvm, cs);
    if (offeredNft) cancelledNftLauncherId = asHex(chia, offeredNft.info.launcherId);
  }
  for (const assetId of catAssetIds) {
    const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, assetId)) as unknown as WasmCat[];
    for (const c of cats) spends.addCat(c);
  }
  if (cancelledNftLauncherId) {
    const ownedNft = await findOwnedNft(chia as unknown as NftWasm, chain, clvm as unknown as NftClvm, keyring, cancelledNftLauncherId);
    spends.addNft(ownedNft as unknown as WasmNft);
  }
  if (!addedXch && catAssetIds.size === 0 && !cancelledNftLauncherId) throw new Error('NOT_OWNER: this wallet did not make this offer');

  const actions: unknown[] = [];
  if (fee > 0n) actions.push(chia.Action.fee(fee));
  const deltas = spends.apply(actions);
  const fin = spends.prepare(deltas);
  for (const ps of fin.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a coin is not owned by this wallet');
    fin.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  fin.spend();
  const coinSpends = clvm.coinSpends();
  const sig = signCoinSpends(chia as unknown as SigningWasm, coinSpends, keyring.map((k) => k.sk), additionalData);
  const bundle = new chia.SpendBundle(coinSpends, sig);
  return {
    bundle,
    summary: { offered: [], requested: [] },
    inputCoinId: coinSpends[0] ? asHex(chia, coinSpends[0].coin.coinId()) : '',
  };
}

