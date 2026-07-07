/**
 * Coin control (#91) — list / split / combine, built on the SAME `Spends`/`Action` driver as the
 * Send flow (no new spend type, no new wasm). Runs in the offscreen vault (holds the seed). Pure
 * (injected wasm + chain), so it is unit-tested against the wasm Simulator through the real driver
 * path; read-only for `listCoins`, and split/combine BUILD spends only — signing + broadcasting is
 * the caller's separately-approved step (the vault reuses `confirmSend`). Never broadcasts.
 *
 * Split and combine are SELF-SENDS: every output must land on a wallet-owned puzzle hash. The
 * summary is decoded FROM THE BUILT SPEND (tamper-resistant, §5.5) and HARD-ASSERTS that invariant
 * — a build that would pay any address outside the wallet throws `SELF_SEND_VIOLATION` (never
 * broadcast). Asset routing is purely by `assetId` (undefined / `'xch'` = native XCH; any other
 * value = a CAT TAIL), the same rule the send flow uses, guarding the #121 asset-drop class.
 */

import { buildKeyring, reconstructCats, type SendFlowWasm, type KeyringEntry } from '@/offscreen/sendFlow';
import type { ChainClient } from '@/offscreen/chain';
import type { SigCoinSpend, SigSecretKey } from '@/offscreen/signing';

/** CLVM max cost when running a puzzle to read its output conditions. */
const MAX_COST = 11_000_000_000n;

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** The wasm surface coin control needs — the send-flow surface (derivation + driver + codecs). */
export type CoinsWasm = SendFlowWasm;

/** One listed unspent coin: its id (hex), amount (base units, decimal string), and confirmed height. */
export interface CoinInfo {
  coinId: string;
  amount: string;
  confirmedHeight: number;
}

/** A decoded, tamper-resistant coin-op summary (base units) read back from the built coin spends. */
export interface CoinOpSummary {
  /** `'XCH'` for native, or the CAT asset id (TAIL hex). */
  asset: string;
  kind: 'split' | 'combine';
  /** How many of the wallet's coins are consumed. */
  inputCoinCount: number;
  /** How many self coins of the asset the op creates. */
  outputCoinCount: number;
  /** Total base units of the asset moved into the self outputs. */
  total: string;
  /** The XCH network fee (mojos). */
  fee: string;
}

/** A prepared (unsigned) coin op: the coin spends to sign, its decoded summary, and the signing keys. */
export interface PreparedCoinOp {
  coinSpends: SigCoinSpend[];
  coinOpSummary: CoinOpSummary;
  secretKeys: SigSecretKey[];
}

const isCatAsset = (assetId?: string): boolean => !!assetId && assetId.toLowerCase() !== 'xch';

/** True when the asset id names a CAT (any value other than undefined / `'xch'`). Exported for the vault. */
export { isCatAsset };

/** The wallet's CAT puzzle hashes (both HD schemes) for one TAIL — where its CAT coins live. */
function catPuzzleHashes(chia: CoinsWasm, keyring: KeyringEntry[], assetIdHex: string): string[] {
  const assetId = chia.fromHex(strip0x(assetIdHex));
  return keyring.map((k) => strip0x(chia.toHex(chia.catPuzzleHash(assetId, chia.fromHex(k.puzzleHashHex)))));
}

/**
 * List the wallet's UNSPENT coins for one asset — native XCH at the derived inner (p2) puzzle hashes,
 * or a CAT at its CAT puzzle hash over the same inner hashes — both HD schemes AT THE ACTIVE INDEX
 * (§165). Each coin carries its id, amount, and confirmed height. Read-only. Routed purely by
 * `assetId` (#121).
 */
export async function listCoins(
  chia: CoinsWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; assetId?: string; activeIndex?: number },
): Promise<CoinInfo[]> {
  const keyring = buildKeyring(chia, opts.seed, { index: opts.activeIndex ?? 0 });
  const innerPhs = keyring.map((k) => k.puzzleHashHex);
  const phs = isCatAsset(opts.assetId) ? catPuzzleHashes(chia, keyring, opts.assetId as string) : innerPhs;
  const records = await chain.coinRecords(phs, { includeSpent: false });
  return records
    .filter((r) => !r.spent)
    .map((r) => ({
      coinId: strip0x(chia.toHex(r.coin.coinId())),
      amount: r.coin.amount.toString(),
      confirmedHeight: r.confirmedHeight,
    }));
}

// ── driver surfaces reached via focused casts (mirrors sendFlow.prepareCatSend) ─────────────────────
interface DriverClvm {
  alloc(value: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  standardSpend(pk: unknown, spend: unknown): unknown;
  coinSpends(): SigCoinSpend[];
  deserialize(bytes: Uint8Array): { run(sol: unknown, cost: bigint, mempool: boolean): { value: { toList(): Array<{ parseCreateCoin(): { puzzleHash: Uint8Array; amount: bigint } | undefined }> | undefined } } };
}
interface DriverSpends {
  addXch(coin: unknown): void;
  addCat(cat: unknown): void;
  apply(actions: unknown[]): unknown;
  prepare(deltas: unknown): {
    pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; p2PuzzleHash(): Uint8Array; conditions(): unknown[] }>;
    insert(id: Uint8Array, spend: unknown): void;
    spend(): unknown;
  };
}
interface CatLike {
  coin: { coinId(): Uint8Array; amount: bigint };
}

/** `Action.send`/`fee` + `Id.xch`/`existing` reached via a cast (SendFlowWasm types only `send`/`fee`/`xch`). */
function actions(chia: CoinsWasm) {
  return {
    send: (chia.Action as unknown as { send(id: unknown, ph: Uint8Array, amount: bigint, memos: unknown): unknown }).send,
    fee: chia.Action.fee,
    xch: () => chia.Id.xch(),
    existing: (assetId: Uint8Array) => (chia.Id as unknown as { existing(a: Uint8Array): unknown }).existing(assetId),
  };
}

/**
 * Decode a coin op's summary from the built coin spends and ENFORCE the self-send invariant: run each
 * puzzle against its solution, read the CREATE_COINs, and require every output puzzle hash to be a
 * wallet-owned XCH or CAT puzzle hash — otherwise throw `SELF_SEND_VIOLATION` (the op is never
 * broadcast). Only outputs of the operated asset are counted into `outputCoinCount` + `total`.
 */
export function decodeCoinOpSummary(
  chia: CoinsWasm,
  clvm: DriverClvm,
  coinSpends: SigCoinSpend[],
  opts: { ownXchPhs: Set<string>; ownCatPhs?: Set<string>; asset: string; kind: 'split' | 'combine'; fee: bigint; inputCoinCount: number },
): CoinOpSummary {
  let total = 0n;
  let outputCoinCount = 0;
  for (const cs of coinSpends) {
    const conditions = clvm.deserialize(cs.puzzleReveal).run(clvm.deserialize(cs.solution), MAX_COST, false).value.toList() ?? [];
    for (const cond of conditions) {
      const cc = cond.parseCreateCoin();
      if (!cc) continue;
      const ph = strip0x(chia.toHex(cc.puzzleHash));
      const isSelfXch = opts.ownXchPhs.has(ph);
      const isSelfCat = opts.ownCatPhs?.has(ph) ?? false;
      if (!isSelfXch && !isSelfCat) {
        throw new Error('SELF_SEND_VIOLATION: a coin-control output is not owned by this wallet');
      }
      const countsForAsset = opts.asset === 'XCH' ? isSelfXch : isSelfCat;
      if (countsForAsset) {
        total += cc.amount;
        outputCoinCount += 1;
      }
    }
  }
  return { asset: opts.asset, kind: opts.kind, inputCoinCount: opts.inputCoinCount, outputCoinCount, total: total.toString(), fee: opts.fee.toString() };
}

/** Gather + select the asset coins to operate on. Returns the driver objects to add + their total + ids. */
async function selectAssetCoins(
  chia: CoinsWasm,
  chain: ChainClient,
  keyring: KeyringEntry[],
  isCat: boolean,
  assetId: string | undefined,
  coinIds: string[],
): Promise<{ objs: unknown[]; total: bigint; count: number }> {
  const want = new Set(coinIds.map(strip0x));
  const innerPhs = keyring.map((k) => k.puzzleHashHex);
  if (!isCat) {
    const coins = await chain.unspentCoins(innerPhs);
    const sel = coins.filter((c) => want.has(strip0x(chia.toHex(c.coinId()))));
    return { objs: sel, total: sel.reduce((s, c) => s + c.amount, 0n), count: sel.length };
  }
  const cats = (await reconstructCats(chia, chain, keyring, assetId as string)) as CatLike[];
  const sel = cats.filter((c) => want.has(strip0x(chia.toHex(c.coin.coinId()))));
  return { objs: sel, total: sel.reduce((s, c) => s + c.coin.amount, 0n), count: sel.length };
}

/** Insert each selected coin's standard inner spend, keyed by its puzzle hash; finalize the coin spends. */
function finalize(
  chia: CoinsWasm,
  clvm: DriverClvm,
  spends: DriverSpends,
  keyring: KeyringEntry[],
  actionList: unknown[],
): SigCoinSpend[] {
  const keyByPh = new Map(keyring.map((k) => [k.puzzleHashHex, k.pk]));
  const finished = spends.prepare(spends.apply(actionList));
  for (const ps of finished.pendingSpends()) {
    const pk = keyByPh.get(strip0x(chia.toHex(ps.p2PuzzleHash())));
    if (!pk) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), clvm.standardSpend(pk, clvm.delegatedSpend(ps.conditions())));
  }
  finished.spend();
  return clvm.coinSpends();
}

/** The wallet's own XCH + (for a CAT op) CAT puzzle-hash sets — the self-send allow-list. */
function ownPhSets(chia: CoinsWasm, keyring: KeyringEntry[], isCat: boolean, assetId?: string): { xch: Set<string>; cat?: Set<string> } {
  const xch = new Set(keyring.map((k) => k.puzzleHashHex));
  if (!isCat) return { xch };
  return { xch, cat: new Set(catPuzzleHashes(chia, keyring, assetId as string)) };
}

/**
 * Compute `outputs` pairwise-DISTINCT positive amounts summing to `spendable` — e.g. to make change
 * denominations. Every piece is assigned to the SAME destination puzzle hash (§165 — the single
 * active-index model has only the active index's own addresses to send change to, not a distinct
 * address per piece), so amounts must never tie: two CREATE_COINs with the same (puzzle hash, amount)
 * pair would collide on-chain (identical coin id). Amounts are consecutive integers `base..base+n-2`
 * plus a strictly-larger final piece absorbing the remainder — provably distinct and positive
 * whenever `base > 0` (the final piece is always `> base+n-2`, the largest of the others).
 */
export function distinctSplitAmounts(spendable: bigint, outputs: number): bigint[] {
  const n = BigInt(outputs);
  const triangular = (n * (n - 1n)) / 2n; // 0+1+...+(outputs-2)
  const base = (spendable - triangular) / n;
  if (base <= 0n) throw new Error('SPLIT_TOO_SMALL: not enough value to make that many distinct coins');
  const amounts: bigint[] = [];
  for (let i = 0; i < outputs - 1; i++) amounts.push(base + BigInt(i));
  amounts.push(spendable - amounts.reduce((a, b) => a + b, 0n));
  return amounts;
}

/**
 * SPLIT one or more coins of an asset into `outputs` self coins of distinct amounts — e.g. to make
 * change denominations. All pieces return to the ACTIVE index's own address (§165 — never spreads
 * across other derivation indexes, which the single-active-index model would then be unable to see).
 * For XCH the fee comes out of the split amount; for a CAT the amount is conserved (CAT can't pay an
 * XCH fee) and XCH coins fund the fee. Builds only — does NOT sign or broadcast.
 */
export async function prepareSplit(
  chia: CoinsWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; assetId?: string; coinIds: string[]; outputs: number; fee: bigint; activeIndex?: number },
): Promise<PreparedCoinOp> {
  const outputs = Math.floor(opts.outputs);
  if (!(outputs >= 2)) throw new Error('SPLIT_MIN_OUTPUTS: split into at least 2 coins');
  const keyring = buildKeyring(chia, opts.seed, { index: opts.activeIndex ?? 0 });
  const isCat = isCatAsset(opts.assetId);

  const selected = await selectAssetCoins(chia, chain, keyring, isCat, opts.assetId, opts.coinIds);
  if (selected.count === 0) throw new Error('NO_SELECTED_COINS: none of the chosen coins are in this wallet');

  const spendable = isCat ? selected.total : selected.total - opts.fee;
  const amounts = distinctSplitAmounts(spendable, outputs);

  const clvm = new chia.Clvm() as unknown as DriverClvm;
  const changePh = chia.fromHex(keyring[0].puzzleHashHex);
  const spends = new chia.Spends(clvm as unknown as never, changePh) as unknown as DriverSpends;
  const act = actions(chia);
  if (isCat) {
    for (const c of await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex))) spends.addXch(c); // fund the XCH fee
    for (const o of selected.objs) spends.addCat(o);
  } else {
    for (const o of selected.objs) spends.addXch(o);
  }

  const assetBytes = isCat ? chia.fromHex(strip0x(opts.assetId as string)) : new Uint8Array();
  const destPh = chia.fromHex(keyring[0].puzzleHashHex); // every piece returns to the active index's own address
  const actionList: unknown[] = amounts.map((amt) =>
    isCat ? act.send(act.existing(assetBytes), destPh, amt, clvm.alloc([destPh])) : act.send(act.xch(), destPh, amt, undefined),
  );
  if (opts.fee > 0n) actionList.push(act.fee(opts.fee));

  const coinSpends = finalize(chia, clvm, spends, keyring, actionList);
  const own = ownPhSets(chia, keyring, isCat, opts.assetId);
  const coinOpSummary = decodeCoinOpSummary(chia, clvm, coinSpends, {
    ownXchPhs: own.xch,
    ...(own.cat ? { ownCatPhs: own.cat } : {}),
    asset: isCat ? strip0x(opts.assetId as string) : 'XCH',
    kind: 'split',
    fee: opts.fee,
    inputCoinCount: selected.count,
  });
  return { coinSpends, coinOpSummary, secretKeys: keyring.map((k) => k.sk) };
}

/**
 * COMBINE two or more coins of an asset into a SINGLE self coin — consolidate dust. For XCH the fee
 * comes out of the combined amount; for a CAT the amount is conserved and XCH coins fund the fee.
 * Builds only — does NOT sign or broadcast.
 */
export async function prepareCombine(
  chia: CoinsWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; assetId?: string; coinIds: string[]; fee: bigint; activeIndex?: number },
): Promise<PreparedCoinOp> {
  if (opts.coinIds.length < 2) throw new Error('NEED_TWO_COINS: combine needs at least two coins');
  const keyring = buildKeyring(chia, opts.seed, { index: opts.activeIndex ?? 0 });
  const isCat = isCatAsset(opts.assetId);

  const selected = await selectAssetCoins(chia, chain, keyring, isCat, opts.assetId, opts.coinIds);
  if (selected.count < 2) throw new Error('NEED_TWO_COINS: fewer than two of the chosen coins are in this wallet');

  const outAmount = isCat ? selected.total : selected.total - opts.fee;
  if (outAmount <= 0n) throw new Error('COMBINE_FEE_TOO_HIGH: the fee is not covered by the combined coins');

  const clvm = new chia.Clvm() as unknown as DriverClvm;
  const destPh = chia.fromHex(keyring[0].puzzleHashHex);
  const spends = new chia.Spends(clvm as unknown as never, destPh) as unknown as DriverSpends;
  const act = actions(chia);
  if (isCat) {
    for (const c of await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex))) spends.addXch(c); // fund the XCH fee
    for (const o of selected.objs) spends.addCat(o);
  } else {
    for (const o of selected.objs) spends.addXch(o);
  }

  const assetBytes = isCat ? chia.fromHex(strip0x(opts.assetId as string)) : new Uint8Array();
  const actionList: unknown[] = [
    isCat ? act.send(act.existing(assetBytes), destPh, outAmount, clvm.alloc([destPh])) : act.send(act.xch(), destPh, outAmount, undefined),
  ];
  if (opts.fee > 0n) actionList.push(act.fee(opts.fee));

  const coinSpends = finalize(chia, clvm, spends, keyring, actionList);
  const own = ownPhSets(chia, keyring, isCat, opts.assetId);
  const coinOpSummary = decodeCoinOpSummary(chia, clvm, coinSpends, {
    ownXchPhs: own.xch,
    ...(own.cat ? { ownCatPhs: own.cat } : {}),
    asset: isCat ? strip0x(opts.assetId as string) : 'XCH',
    kind: 'combine',
    fee: opts.fee,
    inputCoinCount: selected.count,
  });
  return { coinSpends, coinOpSummary, secretKeys: keyring.map((k) => k.sk) };
}
