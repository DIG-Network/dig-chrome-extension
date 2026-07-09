/**
 * Self-custody option contracts (#104, extension-parity P2) — MINT a covered-call-style option
 * (lock XCH as the underlying, set a strike + expiration) and EXERCISE one this wallet holds,
 * assembled from `chia-wallet-sdk-wasm` LOW-LEVEL primitives (`OptionInfo`/`OptionUnderlying`/
 * `OptionType`/`OptionMetadata`, `Clvm.spendOption`/`meltSingleton`/`sendMessage`/
 * `spendSettlementCoin`/`singletonLauncher`) — confirmed present in the shipped `^0.33.0` build (the
 * ticket's own "verify before scoping" note): unlike CAT/NFT, options have NO `Action`/`Spends`
 * driver convenience (no `Action.mintOption`, no `Spends.addOption`), so this module hand-rolls the
 * singleton launch + underlying lock/unlock exactly as the upstream `chia-wallet-sdk`'s OWN
 * `napi/__test__/options.spec.ts` reference test does (the napi and wasm bindings share the same
 * `chia-sdk-bindings` surface, so that test is a byte-for-byte authoritative usage guide here).
 *
 * MVP scope, deliberately narrow (mirrors how `offers.ts`/`dids.ts` document their own gaps):
 *   - **XCH-denominated only** — the underlying (locked collateral) and the strike (exercise price)
 *     are both native XCH. `OptionType.cat`/`.revocableCat`/`.nft` exist in the wasm for a follow-up;
 *     CAT/NFT-denominated options are not built here.
 *   - **Self-mint, self-exercise round trip** — this wallet must be BOTH the writer (creator) and the
 *     holder to exercise (the local {@link OptionRecord} carries the full off-chain terms this
 *     wallet needs to rebuild `OptionUnderlying`; a THIRD PARTY who only ever sees the option's
 *     bare on-chain singleton has no way to learn the strike/expiration/creator without them being
 *     published out-of-band — e.g. a marketplace listing carrying the terms alongside the launcher
 *     id, analogous to how an offer string carries its own terms). Transferring a minted option to
 *     another wallet, and clawing it back after expiry, are tracked follow-ups (`OptionUnderlying.
 *     clawbackSpend` already ships in the wasm for exactly that later work).
 *
 * Mint model: the funding coin creates TWO sibling coins in one spend — the underlying-lock coin
 * (at `OptionUnderlying.puzzleHash()`) and the singleton launcher (at `Constants.
 * singletonLauncherHash()`); the launcher is then spent to create the eve option singleton (at
 * `OptionInfo.puzzleHash()`), which is immediately re-spent once more to commit its REAL (non-eve)
 * lineage — the same "eve create, then re-spend" shape `dids.ts`'s `createEveDid`+`spendDid` uses,
 * except DID has a wasm helper (`Clvm.createEveDid`) that does the launcher plumbing internally;
 * options have no such helper, so the launcher spend (`Clvm.singletonLauncher()` puzzle, solution
 * `(optionPuzzleHash, 1, OptionMetadata)`) is built explicitly here.
 *
 * Exercise model (the option HOLDER, proving control by simultaneously melting the option
 * singleton): (1) melt the option's singleton coin via a delegated spend carrying `meltSingleton()`
 * + a `sendMessage(23, underlying.delegatedPuzzleHash(), [underlyingCoinId])` — mode `23` and the
 * receiver/data shape are copied VERBATIM from the upstream reference test; this is the
 * "SingletonMember" proof-of-simultaneous-spend the underlying's 1-of-N exercise path checks for,
 * (2) fund + settle the strike payment to the creator through the SAME settlement-puzzle mechanism
 * `offers.ts` already uses (a `NotarizedPayment` keyed by the option's own launcher id — this is
 * what the underlying's exercise puzzle itself asserts via `payment_assertion`, so the amount/
 * recipient/hint-ness MUST match `OptionUnderlying`'s own Rust `requested_payment()` byte-for-byte:
 * un-hinted for XCH, per `OptionType::is_hinted()`), (3) unlock the underlying coin
 * (`OptionUnderlying.exerciseSpend`, which the wasm builds internally — no hand-rolled puzzle logic
 * here) and immediately claim the released value (it lands back at the settlement puzzle,
 * un-notarized, so ANY spend can claim it — this module claims it straight to the holder's own
 * address in the SAME bundle rather than leaving a claimable-by-anyone coin behind).
 */

import { buildKeyring, type SendFlowWasm, type KeyringEntry } from '@/offscreen/sendFlow';
import { type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

// ── Minimal structural wasm surfaces (focused casts, per the other offscreen engines) ─────────────
interface OcCoin {
  coinId(): Uint8Array;
  parentCoinInfo: Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
}
interface OcProgram {
  puzzle(): { parseChildOption(parentCoin: OcCoin, parentSolution: OcProgram): OcOptionContract | undefined };
}
interface OcOptionInfo {
  p2PuzzleHash: Uint8Array;
  innerPuzzleHash(): Uint8Array;
  puzzleHash(): Uint8Array;
}
interface OcOptionContract {
  coin: OcCoin;
  info: OcOptionInfo;
}
interface OcOptionUnderlying {
  puzzleHash(): Uint8Array;
  delegatedPuzzleHash(): Uint8Array;
  exerciseSpend(clvm: OcClvm, singletonInnerPuzzleHash: Uint8Array, singletonAmount: bigint): unknown;
}
interface OcSpend {
  puzzle: unknown;
  solution: unknown;
}
interface OcClvm {
  spendCoin(coin: OcCoin, spend: unknown): void;
  spendStandardCoin(coin: OcCoin, syntheticKey: unknown, spend: unknown): void;
  spendOption(option: OcOptionContract, innerSpend: unknown): OcOptionContract | undefined;
  spendSettlementCoin(coin: OcCoin, notarizedPayments: unknown[]): void;
  standardSpend(syntheticKey: unknown, spend: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  createCoin(puzzleHash: Uint8Array, amount: bigint, memos?: unknown): unknown;
  reserveFee(amount: bigint): unknown;
  alloc(value: unknown): unknown;
  meltSingleton(): unknown;
  sendMessage(mode: number, message: Uint8Array, data: unknown[]): unknown;
  singletonLauncher(): unknown;
  deserialize(bytes: Uint8Array): OcProgram;
  coinSpends(): SigCoinSpend[];
}

/** The full wasm surface option contracts need (standalone, like `CatIssuanceWasm`/`DidWasm`). */
export interface OptionWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => OcClvm;
  Coin: new (parentCoinInfo: Uint8Array, puzzleHash: Uint8Array, amount: bigint) => OcCoin;
  Spend: new (puzzle: unknown, solution: unknown) => OcSpend;
  Proof: new (parentParentCoinInfo: Uint8Array, parentInnerPuzzleHash: Uint8Array | undefined, parentAmount: bigint) => unknown;
  NotarizedPayment: new (nonce: Uint8Array, payments: unknown[]) => unknown;
  Payment: new (puzzleHash: Uint8Array, amount: bigint, memos: unknown) => unknown;
  OptionInfo: new (launcherId: Uint8Array, underlyingCoinId: Uint8Array, underlyingDelegatedPuzzleHash: Uint8Array, p2PuzzleHash: Uint8Array) => OcOptionInfo;
  OptionUnderlying: new (launcherId: Uint8Array, creatorPuzzleHash: Uint8Array, seconds: bigint, amount: bigint, strikeType: unknown) => OcOptionUnderlying;
  OptionMetadata: new (expirationSeconds: bigint, strikeType: unknown) => unknown;
  OptionType: { xch(amount: bigint): unknown };
  OptionContract: new (coin: OcCoin, proof: unknown, info: OcOptionInfo) => OcOptionContract;
  Constants: { singletonLauncherHash(): Uint8Array; settlementPaymentHash(): Uint8Array };
  // Derivation surface reused via a cast to SendFlowWasm.
  SecretKey: unknown;
}

const asHex = (chia: OptionWasm, b: Uint8Array): string => strip0x(chia.toHex(b));
const bytes = (chia: OptionWasm, hex: string): Uint8Array => chia.fromHex(strip0x(hex));

/** The chain surface option contracts need — the standard {@link ChainClient}. */
export type OptionChain = ChainClient;

/**
 * The FULL off-chain terms of a minted option, held in a local registry (mirrors `offer-log.ts`'s
 * "your offers" precedent — the chain alone doesn't hand back the strike/expiration/creator for a
 * bare singleton, so the minting wallet remembers them). `underlyingLockParentCoinId` + the other
 * fields deterministically rebuild the exact same underlying-lock `Coin` object at exercise time.
 */
export interface OptionRecord {
  /** The option singleton's launcher id (hex) — its stable on-chain identity. */
  launcherId: string;
  /** The writer's p2 puzzle hash (hex) — receives the strike payment on exercise. */
  creatorPuzzleHashHex: string;
  /** The current holder's p2 puzzle hash (hex) — who can exercise (self-mint: same as creator). */
  holderPuzzleHashHex: string;
  /** Absolute unix seconds after which the option can no longer be exercised (decimal string). */
  expirationSeconds: string;
  /** The locked collateral amount, in base units (decimal string). */
  underlyingAmount: string;
  /** The exercise price, in base units (decimal string). */
  strikeAmount: string;
  /** The underlying-lock coin's PARENT coin id (hex) — the mint's funding coin. */
  underlyingLockParentCoinId: string;
  /** The option's CURRENT (post-mint-commit) coin id, hex — a cheap poll key: once this coin is
   * observed spent (the same `sendStatus`/`coinConfirmed` vault op any confirm-poll already uses),
   * the option has been exercised (MVP has no clawback path yet, so "spent" only ever means that). */
  coinIdHex: string;
}

/** Rebuild the `OptionUnderlying` handle from a record's stored terms. */
function underlyingOf(chia: OptionWasm, record: OptionRecord): OcOptionUnderlying {
  return new chia.OptionUnderlying(
    bytes(chia, record.launcherId),
    bytes(chia, record.creatorPuzzleHashHex),
    BigInt(record.expirationSeconds),
    BigInt(record.underlyingAmount),
    chia.OptionType.xch(BigInt(record.strikeAmount)),
  );
}

/** Rebuild the `OptionInfo` handle from a record's stored terms + its rebuilt `OptionUnderlying`. */
function optionInfoOf(chia: OptionWasm, record: OptionRecord, underlying: OcOptionUnderlying): OcOptionInfo {
  const underlyingLockCoin = new chia.Coin(bytes(chia, record.underlyingLockParentCoinId), underlying.puzzleHash(), BigInt(record.underlyingAmount));
  return new chia.OptionInfo(bytes(chia, record.launcherId), underlyingLockCoin.coinId(), underlying.delegatedPuzzleHash(), bytes(chia, record.holderPuzzleHashHex));
}

/** A prepared (unsigned) option mint: coin spends + the keys to sign + the record + a summary. */
export interface PreparedOptionMint {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  record: OptionRecord;
  summary: OptionMintSummary;
}
export interface OptionMintSummary extends OptionRecord {
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) the MINT of a new XCH-denominated option owned by this
 * wallet (writer AND initial holder, #104). Locks `underlyingAmount` mojos of XCH as collateral,
 * exercisable for `strikeAmount` mojos of XCH until `expirationSeconds` (absolute unix time). Funded
 * from the wallet's XCH coins (largest-first, #179-style fragmented-wallet funding when one coin
 * doesn't cover it); the underlying lock + launcher + change/fee all land in the SAME funding spend.
 * Returns the {@link OptionRecord} the caller MUST persist (via a local registry, e.g. #101's
 * offer-log pattern) — it is the only way this wallet can later exercise the option.
 */
export async function prepareOptionMint(
  chia: OptionWasm,
  chain: OptionChain,
  opts: { seed: Uint8Array; underlyingAmount: bigint; strikeAmount: bigint; expirationSeconds: bigint; fee?: bigint; activeIndex?: number },
): Promise<PreparedOptionMint> {
  if (opts.underlyingAmount <= 0n) throw new Error('BAD_REQUEST: underlyingAmount must be positive');
  if (opts.strikeAmount <= 0n) throw new Error('BAD_REQUEST: strikeAmount must be positive');
  if (opts.expirationSeconds <= 0n) throw new Error('BAD_REQUEST: expirationSeconds must be a positive absolute unix timestamp');
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));
  const ownPh = keyring[0]!;
  const ownP2 = bytes(chia, ownPh.puzzleHashHex);

  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  if (xchCoins.length === 0) throw new Error('NO_XCH_COINS: the wallet has no XCH to fund the mint');

  const LAUNCHER_AMOUNT = 1n;
  const needed = opts.underlyingAmount + LAUNCHER_AMOUNT + fee;
  const sorted = [...xchCoins].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const selected: ChainCoin[] = [];
  let total = 0n;
  for (const c of sorted) {
    if (total >= needed) break;
    selected.push(c);
    total += c.amount;
  }
  if (total < needed) throw new Error('NO_SUITABLE_COIN: even combining every coin, the wallet cannot fund the underlying + launcher + fee');
  const [primary, ...extra] = selected as [ChainCoin, ...ChainCoin[]];
  const primaryKey = keyByPuzzleHash.get(asHex(chia, primary.puzzleHash));
  if (!primaryKey) throw new Error('MISSING_KEY: the funding coin is not owned by this wallet');

  const clvm = new chia.Clvm();
  const launcherId = new chia.Coin(primary.coinId(), chia.Constants.singletonLauncherHash(), LAUNCHER_AMOUNT).coinId();

  const underlying = new chia.OptionUnderlying(launcherId, ownP2, opts.expirationSeconds, opts.underlyingAmount, chia.OptionType.xch(opts.strikeAmount));
  const underlyingLockPh = underlying.puzzleHash();
  const optionInfo = new chia.OptionInfo(launcherId, new chia.Coin(primary.coinId(), underlyingLockPh, opts.underlyingAmount).coinId(), underlying.delegatedPuzzleHash(), ownP2);

  const changeAmount = total - needed;
  const fundingConditions: unknown[] = [
    clvm.createCoin(underlyingLockPh, opts.underlyingAmount),
    clvm.createCoin(chia.Constants.singletonLauncherHash(), LAUNCHER_AMOUNT),
  ];
  if (changeAmount > 0n) fundingConditions.push(clvm.createCoin(primary.puzzleHash, changeAmount));
  if (fee > 0n) fundingConditions.push(clvm.reserveFee(fee));
  clvm.spendStandardCoin(primary, primaryKey.pk, clvm.delegatedSpend(fundingConditions));
  for (const c of extra) {
    const k = keyByPuzzleHash.get(asHex(chia, c.puzzleHash));
    if (!k) throw new Error('MISSING_KEY: a funding coin is not owned by this wallet');
    clvm.spendStandardCoin(c, k.pk, clvm.delegatedSpend([]));
  }

  const launcherCoin = new chia.Coin(primary.coinId(), chia.Constants.singletonLauncherHash(), LAUNCHER_AMOUNT);
  clvm.spendCoin(launcherCoin, new chia.Spend(clvm.singletonLauncher(), clvm.alloc([optionInfo.puzzleHash(), 1n, new chia.OptionMetadata(opts.expirationSeconds, chia.OptionType.xch(opts.strikeAmount))])));

  const eveOption = new chia.OptionContract(new chia.Coin(launcherId, optionInfo.puzzleHash(), 1n), new chia.Proof(launcherCoin.parentCoinInfo, undefined, launcherCoin.amount), optionInfo);
  const committed = clvm.spendOption(eveOption, clvm.standardSpend(ownPh.pk, clvm.delegatedSpend([clvm.createCoin(optionInfo.p2PuzzleHash, 1n, clvm.alloc([ownP2]))])));
  if (!committed) throw new Error('MINT_FAILED: the option spend did not produce a valid contract');

  const coinSpends = clvm.coinSpends();
  const record: OptionRecord = {
    launcherId: asHex(chia, launcherId),
    creatorPuzzleHashHex: ownPh.puzzleHashHex,
    holderPuzzleHashHex: ownPh.puzzleHashHex,
    expirationSeconds: opts.expirationSeconds.toString(),
    underlyingAmount: opts.underlyingAmount.toString(),
    strikeAmount: opts.strikeAmount.toString(),
    underlyingLockParentCoinId: asHex(chia, primary.coinId()),
    coinIdHex: asHex(chia, committed.coin.coinId()),
  };
  const secretKeys: SigSecretKey[] = [primaryKey.sk, ...extra.map((c) => keyByPuzzleHash.get(asHex(chia, c.puzzleHash))!.sk), ownPh.sk];
  return { coinSpends, secretKeys, record, summary: { ...record, fee: fee.toString(), coinCount: coinSpends.length } };
}

/** A prepared (unsigned) option exercise: coin spends + the keys to sign + a summary. */
export interface PreparedOptionExercise {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: OptionExerciseSummary;
}
export interface OptionExerciseSummary {
  launcherId: string;
  strikeAmount: string;
  underlyingAmount: string;
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) the EXERCISE of an option this wallet holds (#104): melt the
 * option singleton (proving control), pay the strike to the creator through the settlement puzzle,
 * unlock the collateral, and claim the released value straight to the holder's own address — all in
 * ONE bundle. Throws `OPTION_NOT_FOUND` if the option's live coin can't be located at its expected
 * (deterministic) puzzle hash, `EXPIRED` past `expirationSeconds`, `MISSING_KEY` if this wallet does
 * not hold the recorded holder key, or `NO_SUITABLE_COIN` if it cannot fund the strike + fee.
 */
export async function prepareOptionExercise(
  chia: OptionWasm,
  chain: OptionChain,
  opts: { seed: Uint8Array; record: OptionRecord; fee?: bigint; activeIndex?: number; nowSeconds?: bigint },
): Promise<PreparedOptionExercise> {
  const fee = opts.fee ?? 0n;
  const now = opts.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (now >= BigInt(opts.record.expirationSeconds)) throw new Error('EXPIRED: this option can no longer be exercised (past its expiration)');
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));
  const holderKey = keyByPuzzleHash.get(strip0x(opts.record.holderPuzzleHashHex));
  if (!holderKey) throw new Error('MISSING_KEY: this wallet does not hold the option (not the recorded holder)');

  const launcherId = bytes(chia, opts.record.launcherId);
  const creatorPh = bytes(chia, opts.record.creatorPuzzleHashHex);
  const holderP2 = bytes(chia, opts.record.holderPuzzleHashHex);
  const underlyingAmount = BigInt(opts.record.underlyingAmount);
  const strikeAmount = BigInt(opts.record.strikeAmount);

  const clvm = new chia.Clvm();
  const underlying = underlyingOf(chia, opts.record);
  const optionInfo = optionInfoOf(chia, opts.record, underlying);
  const optionPh = optionInfo.puzzleHash();
  // Deterministic from the recorded terms — the SAME coin the mint's funding spend created, and the
  // one the exercise spend (step 3) unlocks.
  const underlyingLockCoin = new chia.Coin(bytes(chia, opts.record.underlyingLockParentCoinId), underlying.puzzleHash(), underlyingAmount);

  // The option's puzzle hash is fully deterministic from its recorded terms — find its live coin
  // directly (no hint-scan needed).
  const liveCoins = await chain.unspentCoins([asHex(chia, optionPh)]);
  const liveCoin = liveCoins[0];
  if (!liveCoin) throw new Error('OPTION_NOT_FOUND: no live option coin at the expected puzzle hash (already exercised/clawed back, or not yet confirmed)');

  const parentSpend = await chain.getCoinSpend(asHex(chia, liveCoin.parentCoinInfo));
  if (!parentSpend) throw new Error('OPTION_NOT_FOUND: the option coin has no discoverable parent spend');
  const puzzle = clvm.deserialize(parentSpend.puzzleReveal).puzzle();
  const option = puzzle.parseChildOption(parentSpend.coin as unknown as OcCoin, clvm.deserialize(parentSpend.solution));
  if (!option || asHex(chia, option.coin.coinId()) !== asHex(chia, liveCoin.coinId())) {
    throw new Error('OPTION_NOT_FOUND: could not reconstruct the option contract from its parent spend');
  }

  // 1) Melt the option singleton + prove control to the underlying's exercise path (SingletonMember,
  // via the SendMessage the upstream reference test's mode/receiver/data shape is copied from).
  const melted = clvm.spendOption(
    option,
    clvm.standardSpend(holderKey.pk, clvm.delegatedSpend([clvm.meltSingleton(), clvm.sendMessage(23, underlying.delegatedPuzzleHash(), [clvm.alloc(underlyingLockCoin.coinId())])])),
  );
  if (melted) throw new Error('EXERCISE_FAILED: melting the option unexpectedly produced a child singleton');

  // 2) Fund + settle the strike payment to the creator (un-hinted for XCH, matching OptionUnderlying's
  // own requested_payment() byte-for-byte — a mismatch would make the underlying's own assertion fail).
  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  const needed = strikeAmount + fee;
  const sorted = [...xchCoins].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const selected: ChainCoin[] = [];
  let total = 0n;
  for (const c of sorted) {
    if (total >= needed) break;
    selected.push(c);
    total += c.amount;
  }
  if (total < needed) throw new Error('NO_SUITABLE_COIN: even combining every coin, the wallet cannot fund the strike + fee');
  const [primary, ...extra] = selected as [ChainCoin, ...ChainCoin[]];
  const primaryKey = keyByPuzzleHash.get(asHex(chia, primary.puzzleHash));
  if (!primaryKey) throw new Error('MISSING_KEY: the strike-funding coin is not owned by this wallet');
  const changeAmount = total - needed;
  const strikeFundConditions: unknown[] = [clvm.createCoin(chia.Constants.settlementPaymentHash(), strikeAmount)];
  if (changeAmount > 0n) strikeFundConditions.push(clvm.createCoin(primary.puzzleHash, changeAmount));
  if (fee > 0n) strikeFundConditions.push(clvm.reserveFee(fee));
  clvm.spendStandardCoin(primary, primaryKey.pk, clvm.delegatedSpend(strikeFundConditions));
  for (const c of extra) {
    const k = keyByPuzzleHash.get(asHex(chia, c.puzzleHash));
    if (!k) throw new Error('MISSING_KEY: a strike-funding coin is not owned by this wallet');
    clvm.spendStandardCoin(c, k.pk, clvm.delegatedSpend([]));
  }
  const strikeSettlementCoin = new chia.Coin(primary.coinId(), chia.Constants.settlementPaymentHash(), strikeAmount);
  clvm.spendSettlementCoin(strikeSettlementCoin, [new chia.NotarizedPayment(launcherId, [new chia.Payment(creatorPh, strikeAmount, undefined)])]);

  // 3) Unlock the underlying (the wasm builds the 1-of-N exercise puzzle logic internally — no
  // hand-rolled puzzle here) and claim the released collateral straight to the holder in this bundle.
  clvm.spendCoin(underlyingLockCoin, underlying.exerciseSpend(clvm, option.info.innerPuzzleHash(), option.coin.amount));
  const releasedCoin = new chia.Coin(underlyingLockCoin.coinId(), chia.Constants.settlementPaymentHash(), underlyingAmount);
  clvm.spendSettlementCoin(releasedCoin, [new chia.NotarizedPayment(launcherId, [new chia.Payment(holderP2, underlyingAmount, clvm.alloc([holderP2]))])]);

  const coinSpends = clvm.coinSpends();
  const secretKeys: SigSecretKey[] = [holderKey.sk, primaryKey.sk, ...extra.map((c) => keyByPuzzleHash.get(asHex(chia, c.puzzleHash))!.sk)];
  return {
    coinSpends,
    secretKeys,
    summary: { launcherId: opts.record.launcherId, strikeAmount: opts.record.strikeAmount, underlyingAmount: opts.record.underlyingAmount, fee: fee.toString(), coinCount: coinSpends.length },
  };
}

/** Re-export for callers that need to type a `KeyringEntry` alongside this module. */
export type { KeyringEntry };
