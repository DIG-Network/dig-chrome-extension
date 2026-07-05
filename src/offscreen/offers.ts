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
 * v1 supports a single offered asset and a single requested asset, each XCH or a CAT — which covers
 * every XCH↔token trade (e.g. buy/sell $DIG). NFT/DID/option offers are a later extension.
 */

import { buildKeyring, reconstructCats, type SendFlowWasm } from '@/offscreen/sendFlow';
import { signCoinSpends, MAINNET_AGG_SIG_ME, type SigningWasm, type SigCoinSpend } from '@/offscreen/signing';
import type { ChainClient, ChainSpendBundle } from '@/offscreen/chain';

const MAX_COST = 11_000_000_000n;
const ZERO32 = new Uint8Array(32);
const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** An asset side of an offer: native XCH or a CAT identified by its TAIL (asset id) hex. */
export type OfferAsset = { kind: 'xch' } | { kind: 'cat'; assetId: string };

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
  Payment: new (puzzleHash: Uint8Array, amount: bigint, memos: undefined) => unknown;
  Action: {
    send(id: unknown, puzzleHash: Uint8Array, amount: bigint, memos: undefined): unknown;
    fee(amount: bigint): unknown;
    settle(id: unknown, np: WasmNotarizedPayment): unknown;
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

/** The settlement puzzle hash for an asset: SETTLE for XCH, CAT-wrapped SETTLE for a CAT. */
function settlementPuzzleHash(chia: OfferWasm, asset: OfferAsset): Uint8Array {
  const settle = chia.Constants.settlementPaymentHash();
  return asset.kind === 'xch' ? settle : chia.catPuzzleHash(bytes(chia, asset.assetId), settle);
}

/** The payment-assertion announcement id = sha256(settlementPuzzleHash ‖ treeHash(notarizedPayment)). */
function paymentAssertionId(chia: OfferWasm, clvm: WasmClvm, asset: OfferAsset, np: WasmNotarizedPayment): Uint8Array {
  const ph = settlementPuzzleHash(chia, asset);
  const npHash = clvm.alloc(np).treeHash();
  const buf = new Uint8Array(ph.length + npHash.length);
  buf.set(ph, 0);
  buf.set(npHash, ph.length);
  return chia.sha256(buf);
}

/** Build the phantom requested-payment carrier coin spend (ZERO parent, amount 0). */
function buildPhantomCarrier(chia: OfferWasm, asset: OfferAsset, np: WasmNotarizedPayment): WasmCoinSpend {
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
  opts: { seed: Uint8Array; offered: OfferLeg; requested: OfferLeg; fee?: bigint; gapLimit?: number; additionalDataHex?: string },
): Promise<MadeOffer> {
  if (opts.offered.asset.kind === opts.requested.asset.kind && opts.offered.asset.kind === 'xch') {
    throw new Error('SAME_ASSET: cannot trade XCH for XCH');
  }
  if (opts.offered.asset.kind === 'cat' && opts.requested.asset.kind === 'cat' && opts.offered.asset.assetId === opts.requested.asset.assetId) {
    throw new Error('SAME_ASSET: cannot trade a token for itself');
  }
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex); // requested payment + change → index-0
  const settleHash = chia.Constants.settlementPaymentHash();

  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, receivePh);

  // Add the OFFERED coins (+ XCH to cover the fee) and record their ids for the nonce.
  const offeredCoinIds: Uint8Array[] = [];
  if (opts.offered.asset.kind === 'xch') {
    const xch = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
    for (const c of xch) {
      spends.addXch(c as unknown as WasmCoin);
      offeredCoinIds.push((c as unknown as WasmCoin).coinId());
    }
  } else {
    const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, opts.offered.asset.assetId)) as unknown as WasmCat[];
    if (cats.length === 0) throw new Error('NO_CAT_COINS: the wallet holds none of this token');
    for (const c of cats) {
      spends.addCat(c);
      offeredCoinIds.push(c.coin.coinId());
    }
    if (fee > 0n) for (const c of await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex))) spends.addXch(c as unknown as WasmCoin);
  }

  const nonce = offerNonce(clvm, offeredCoinIds);
  const reqNp = notarizedPayment(chia, nonce, receivePh, opts.requested.amount);

  const offeredId = opts.offered.asset.kind === 'xch' ? chia.Id.xch() : chia.Id.existing(bytes(chia, opts.offered.asset.assetId));
  const actions: unknown[] = [chia.Action.send(offeredId, settleHash, opts.offered.amount, undefined)];
  if (fee > 0n) actions.push(chia.Action.fee(fee));
  const deltas = spends.apply(actions);
  spends.addRequiredCondition(clvm.assertPuzzleAnnouncement(paymentAssertionId(chia, clvm, opts.requested.asset, reqNp)));

  const fin = spends.prepare(deltas);
  for (const ps of fin.pendingSpends()) {
    const key = keyByPuzzleHash.get(asHex(chia, ps.p2PuzzleHash()));
    if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    fin.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  fin.spend();
  const realCoinSpends = clvm.coinSpends();
  const sig = signCoinSpends(chia as unknown as SigningWasm, realCoinSpends, keyring.map((k) => k.sk), additionalData);

  const phantom = buildPhantomCarrier(chia, opts.requested.asset, reqNp);
  const bundle = new chia.SpendBundle([...realCoinSpends, phantom as unknown as SigCoinSpend], sig);
  const offer = chia.encodeOffer(bundle);
  return {
    offer,
    summary: {
      offered: [opts.offered],
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
): { xchCoins: WasmCoin[]; cats: WasmCat[]; legs: OfferLeg[] } {
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());
  const xchCoins: WasmCoin[] = [];
  const legs: OfferLeg[] = [];
  const catAssetIds = new Set<string>();
  let xchTotal = 0n;
  for (const cs of real) {
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
  return { xchCoins, cats, legs };
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
  opts: { seed: Uint8Array; offerStr: string; fee?: bigint; gapLimit?: number; additionalDataHex?: string },
): Promise<PreparedTrade> {
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const decoded = chia.decodeOffer(opts.offerStr.trim());
  const clvm = new chia.Clvm();
  const { real, phantom } = splitDecoded(chia, decoded);
  const requested = parseRequested(chia, clvm, phantom);
  const offered = offeredSettlementLegs(chia, clvm, decoded, real);

  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex);
  const settleHex = asHex(chia, chia.Constants.settlementPaymentHash());

  const spends = new chia.Spends(clvm, receivePh);
  // Offered coins → the taker receives them.
  for (const c of offered.xchCoins) spends.addXch(c);
  for (const c of offered.cats) spends.addCat(c);
  // Fund the requested payments from the wallet.
  const xch = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  for (const c of xch) spends.addXch(c as unknown as WasmCoin);
  for (const req of requested) {
    if (req.asset.kind === 'cat') {
      const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, req.asset.assetId)) as unknown as WasmCat[];
      if (cats.length === 0) throw new Error('NO_CAT_COINS: the wallet cannot fund a requested token');
      for (const c of cats) spends.addCat(c);
    }
  }

  const actions: unknown[] = requested.map((req) =>
    chia.Action.settle(req.asset.kind === 'xch' ? chia.Id.xch() : chia.Id.existing(bytes(chia, req.asset.assetId)), req.np),
  );
  if (fee > 0n) actions.push(chia.Action.fee(fee));
  const deltas = spends.apply(actions);
  const takeNonce = offerNonce(clvm, [...offered.xchCoins, ...offered.cats.map((c) => c.coin)].map((c) => c.coinId()));
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
  opts: { seed: Uint8Array; offerStr: string; fee?: bigint; gapLimit?: number; additionalDataHex?: string },
): Promise<PreparedTrade> {
  const fee = opts.fee ?? 0n;
  const additionalData = opts.additionalDataHex ?? MAINNET_AGG_SIG_ME;
  const decoded = chia.decodeOffer(opts.offerStr.trim());
  const clvm = new chia.Clvm();
  const { real } = splitDecoded(chia, decoded);

  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const receivePh = bytes(chia, keyring[0].puzzleHashHex);
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));

  // The maker's original coins = the real spends' input coins (they belong to this wallet).
  const spends = new chia.Spends(clvm, receivePh);
  const catAssetIds = new Set<string>();
  let addedXch = false;
  for (const cs of real) {
    const p2 = asHex(chia, cs.coin.puzzleHash);
    if (ownedPhs.has(p2)) {
      spends.addXch(cs.coin);
      addedXch = true;
    } else {
      const assetId = catAssetIdOf(chia, clvm, cs);
      if (assetId) catAssetIds.add(assetId);
    }
  }
  for (const assetId of catAssetIds) {
    const cats = (await reconstructCats(chia as unknown as SendFlowWasm, chain, keyring, assetId)) as unknown as WasmCat[];
    for (const c of cats) spends.addCat(c);
  }
  if (!addedXch && catAssetIds.size === 0) throw new Error('NOT_OWNER: this wallet did not make this offer');

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

