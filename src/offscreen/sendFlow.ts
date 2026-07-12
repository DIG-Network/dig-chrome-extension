/**
 * Send flow orchestration (§6 Send) — the link between the wallet's keys/coins and the pure spend
 * builder. Runs in the offscreen vault (holds the seed). Derives the HD keyring (both schemes),
 * fetches the wallet's unspent coins, builds the XCH spend + decoded summary (`send.ts`), and — on
 * a separate approved step — signs + bundles (`signing.ts`). Broadcasting is the caller's approved
 * step. Pure (injected wasm + chain); proven consensus-valid against the wasm simulator.
 */

import { buildXchSend, type SendWasm, type KeyPair, type SpendSummary } from '@/offscreen/send';
import { signCoinSpends, type SigningWasm, type SigSecretKey, type SigCoinSpend } from '@/offscreen/signing';
import type { ChainClient, ChainSpendBundle } from '@/offscreen/chain';
import { WALLET_PATH_PREFIX, type Scheme } from '@/lib/keystore/derive';
import { clawbackDestination, type ClawbackInfo, type ClawbackWasm } from '@/offscreen/clawback';
import { selectSpendCoins, type SelectCoinsFn } from '@/offscreen/coinSelect';
import type { Coin as Chip35Coin } from '@dignetwork/chip35-dl-coin-wasm';

/** A wasm secret key with the derivation + signing surface the flow needs. */
interface FullSecretKey extends SigSecretKey {
  deriveUnhardenedPath(path: number[]): FullSecretKey;
  deriveHardenedPath(path: number[]): FullSecretKey;
  deriveSynthetic(): FullSecretKey;
  publicKey(): KeyPair['pk'];
}

/**
 * The wasm surface the send flow needs (derivation + address decode + bundle + build + sign).
 * Extends `SendWasm` only — `SigningWasm` types `Clvm.deserialize`'s Program differently, so the
 * signer receives a cast in `signAndBundle` rather than a conflicting intersection here.
 */
export interface SendFlowWasm extends SendWasm {
  SecretKey: { fromSeed(seed: Uint8Array): FullSecretKey };
  standardPuzzleHash(syntheticKey: KeyPair['pk']): Uint8Array;
  catPuzzleHash(assetId: Uint8Array, innerPuzzleHash: Uint8Array): Uint8Array;
  fromHex(hex: string): Uint8Array;
  Signature: { aggregate(signatures: unknown[]): unknown };
  Address: { decode(address: string): { puzzleHash: Uint8Array; free?(): void } };
  SpendBundle: new (coinSpends: SigCoinSpend[], signature: unknown) => ChainSpendBundle;
}

// The extra CAT-layer wasm surface (reached via focused casts — see reconstructCats/prepareCatSend).
interface CatObj {
  coin: { coinId(): Uint8Array };
  info: { assetId: Uint8Array; p2PuzzleHash: Uint8Array };
}
interface CatPuzzle {
  parseChildCats(parentCoin: unknown, parentSolution: unknown): CatObj[] | undefined;
}

/** One derived signing slot: its standard puzzle hash + the synthetic public + secret key. */
export interface KeyringEntry {
  puzzleHashHex: string;
  pk: KeyPair['pk'];
  sk: SigSecretKey;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** The `Clvm.alloc` surface a plain-text memo is built against (see {@link buildPlainMemo}). */
interface MemoClvm {
  alloc(items: unknown[]): unknown;
}

/**
 * Build a plain-text memo Program (#105) — a SINGLE-atom CREATE_COIN memo list, distinct from
 * clawback's 2-element `[receiverPuzzleHash, clawback.memo()]` list (`offscreen/clawback.ts`) so
 * the two are never conflated on decode (`send.ts`'s `decodePlainMemo`). `Uint8Array.from(...)`
 * normalizes `TextEncoder` output, which can otherwise fail the wasm boundary's `instanceof
 * Uint8Array` check under Vitest/jsdom (a cross-realm typed array) — see send.test.ts.
 */
function buildPlainMemo(clvm: unknown, memo: string): unknown {
  const bytes = Uint8Array.from(new TextEncoder().encode(memo));
  return (clvm as MemoClvm).alloc([bytes]);
}

/**
 * Restrict coins to a hand-picked selection (coin control, #91). When `selectedCoinIds` is given, only
 * coins whose id is in it are kept and an empty result throws `NO_SELECTED_COINS` (so a stale selection
 * fails loudly instead of silently auto-selecting). When it is absent, the full set passes through and
 * the driver auto-selects. `coinId()` is used so it works for both XCH coins and reconstructed CATs.
 */
function filterSelected<T extends { coin?: { coinId(): Uint8Array }; coinId?(): Uint8Array }>(
  chia: { toHex(b: Uint8Array): string },
  coins: T[],
  selectedCoinIds: string[] | undefined,
  idOf: (c: T) => Uint8Array,
): T[] {
  if (!selectedCoinIds || selectedCoinIds.length === 0) return coins;
  const want = new Set(selectedCoinIds.map((id) => strip0x(id)));
  const kept = coins.filter((c) => want.has(strip0x(chia.toHex(idOf(c)))));
  if (kept.length === 0) throw new Error('NO_SELECTED_COINS: none of the chosen coins are in this wallet');
  return kept;
}

/** Map an on-chain coin (XCH `ChainCoin` or a reconstructed CAT's `.coin`) to a chip35 `Coin`. */
function toChip35Coin(c: { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint }): Chip35Coin {
  return { parentCoinInfo: c.parentCoinInfo, puzzleHash: c.puzzleHash, amount: c.amount };
}

/**
 * Resolve the coin ids that fund a spend (#417). A hand-picked coin-control selection (#91,
 * `selectedCoinIds`) ALWAYS wins — the user's override is never second-guessed. Otherwise, when a
 * chip35 `select` is injected, pick high-value-first up to the cap via {@link selectSpendCoins} and
 * return the chosen ids (throwing the typed `NEEDS_CONSOLIDATION` / `INSUFFICIENT_FUNDS` signal the
 * vault surfaces as a `code`). With neither, returns `undefined` so the driver auto-selects (legacy).
 */
function resolveFundingCoinIds<C>(
  chia: { toHex(b: Uint8Array): string },
  args: {
    candidates: C[];
    selectedCoinIds: string[] | undefined;
    select: SelectCoinsFn | undefined;
    target: bigint;
    asset: Parameters<SelectCoinsFn>[2];
    coinOf: (c: C) => Chip35Coin;
    idOf: (c: C) => Uint8Array;
    cap?: number;
  },
): string[] | undefined {
  if (args.selectedCoinIds && args.selectedCoinIds.length > 0) return args.selectedCoinIds;
  if (!args.select) return undefined;
  const chosen = selectSpendCoins({
    candidates: args.candidates,
    target: args.target,
    asset: args.asset,
    coinOf: args.coinOf,
    select: args.select,
    ...(args.cap != null ? { cap: args.cap } : {}),
  });
  return chosen.selected.map((c) => strip0x(chia.toHex(args.idOf(c))));
}

/**
 * Derive the HD keyring for ONE derivation index (§165 — the single active-index model): its
 * standard puzzle hash → synthetic key, for each scheme (both unhardened + hardened by default —
 * funds may sit on either scheme at that index). This is the ONLY set of addresses any read/send
 * op derives; there is no multi-index sweep here or anywhere downstream of it.
 */
export function buildKeyring(
  chia: SendFlowWasm,
  seed: Uint8Array,
  opts: { schemes?: Scheme[]; index: number },
): KeyringEntry[] {
  const schemes = opts.schemes ?? (['unhardened', 'hardened'] as Scheme[]);
  const master = chia.SecretKey.fromSeed(seed);
  try {
    const out: KeyringEntry[] = [];
    for (const scheme of schemes) {
      const path = [...WALLET_PATH_PREFIX, opts.index];
      const account = scheme === 'hardened' ? master.deriveHardenedPath(path) : master.deriveUnhardenedPath(path);
      const sk = account.deriveSynthetic();
      account.free?.();
      const pk = sk.publicKey();
      out.push({ puzzleHashHex: strip0x(chia.toHex(chia.standardPuzzleHash(pk))), pk, sk });
    }
    return out;
  } finally {
    master.free?.();
  }
}

/** A prepared (unsigned) XCH send: coin spends, the decoded summary, and the keys to sign with. */
export interface PreparedSend {
  coinSpends: SigCoinSpend[];
  summary: SpendSummary;
  secretKeys: SigSecretKey[];
  /** Present iff `clawbackSeconds` was given — the params the sender/UI needs to later CLAIM
   * (receiver) or CLAW BACK (sender) this locked coin (#152); see `offscreen/clawback.ts`. */
  clawbackInfo?: ClawbackInfo;
}

/**
 * Prepare an XCH send: derive the ACTIVE index's keyring, fetch the wallet's unspent coins at it,
 * decode the recipient, and build the spend + summary. Does NOT sign or broadcast. Change returns
 * to the active index's unhardened address.
 *
 * `clawbackSeconds` (#152, optional): send WITH a clawback window instead of a plain send — the
 * built CREATE_COIN targets the `ClawbackV2` puzzle hash (not the recipient's own puzzle hash) with
 * `[receiverPuzzleHash, clawback.memo()]` memos, so the recipient can only CLAIM after this absolute
 * unix timestamp, and the sender can CLAW BACK any time before they do (`offscreen/clawback.ts`
 * builds those two follow-up spends). The decoded summary still reports the full sent amount (the
 * "sent" side of the ledger doesn't change — only where it settles does).
 *
 * `memo` (#105, optional): attach a plain-text note to the recipient's CREATE_COIN — memos are
 * PUBLIC on chain, so this is for a payment reference, not a secret. Mutually exclusive with
 * `clawbackSeconds` in v1 (the vault layer rejects combining them, `vault.ts`'s `prepareSend`) —
 * a clawback send's memo slot already carries the reconstruction params.
 */
export async function prepareXchSend(
  chia: SendFlowWasm,
  chain: ChainClient,
  opts: {
    seed: Uint8Array;
    recipient: string;
    amount: bigint;
    fee: bigint;
    activeIndex?: number;
    selectedCoinIds?: string[];
    clawbackSeconds?: bigint;
    memo?: string;
    /** #417 — the injected chip35 `selectCoins`; when present (and no #91 override) the send funds
     * from a capped, high-value-first selection, throwing NEEDS_CONSOLIDATION / INSUFFICIENT_FUNDS. */
    select?: SelectCoinsFn;
    cap?: number;
  },
): Promise<PreparedSend> {
  const keyring = buildKeyring(chia, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map<string, KeyPair>(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const allCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  const fundingIds = resolveFundingCoinIds(chia, {
    candidates: allCoins,
    selectedCoinIds: opts.selectedCoinIds,
    select: opts.select,
    target: opts.amount + opts.fee, // XCH coins must cover both the amount AND the fee
    asset: { xch: true },
    coinOf: (c) => toChip35Coin(c),
    idOf: (c) => c.coinId(),
    ...(opts.cap != null ? { cap: opts.cap } : {}),
  });
  const coins = filterSelected(chia, allCoins, fundingIds, (c) => c.coinId());
  const receiverPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);

  let destPuzzleHash = receiverPuzzleHash;
  let buildMemos: ((clvm: unknown) => unknown) | undefined;
  let clawbackInfo: ClawbackInfo | undefined;
  if (opts.clawbackSeconds != null) {
    clawbackInfo = {
      senderPuzzleHashHex: keyring[0].puzzleHashHex,
      receiverPuzzleHashHex: strip0x(chia.toHex(receiverPuzzleHash)),
      seconds: opts.clawbackSeconds,
      amount: opts.amount,
    };
    const dest = clawbackDestination(chia as unknown as ClawbackWasm, clawbackInfo);
    destPuzzleHash = dest.puzzleHash;
    buildMemos = dest.buildMemos;
  } else if (opts.memo) {
    buildMemos = (clvm: unknown) => buildPlainMemo(clvm, opts.memo as string);
  }

  const built = buildXchSend(chia, {
    coins,
    keyByPuzzleHash,
    destPuzzleHash,
    amount: opts.amount,
    fee: opts.fee,
    changePuzzleHash,
    ...(buildMemos ? { buildMemos } : {}),
  });
  return { coinSpends: built.coinSpends, summary: built.summary, secretKeys: keyring.map((k) => k.sk), ...(clawbackInfo ? { clawbackInfo } : {}) };
}

/** Sign a prepared send and return the broadcastable SpendBundle (the approved, final step). */
export function signAndBundle(
  chia: SendFlowWasm,
  coinSpends: SigCoinSpend[],
  secretKeys: SigSecretKey[],
  additionalDataHex: string,
): ChainSpendBundle {
  // SendWasm + SigningWasm both type Clvm.deserialize's Program differently; cast for the signer.
  const sig = signCoinSpends(chia as unknown as SigningWasm, coinSpends, secretKeys, additionalDataHex);
  return new chia.SpendBundle(coinSpends, sig);
}

/**
 * Reconstruct the wallet's CAT coins of one asset id, each with its lineage proof, by computing the
 * CAT puzzle hashes over the keyring, fetching those coins, and — for each — parsing the parent's
 * spend (`Puzzle.parseChildCats`). Returns the wasm `Cat` objects to feed the send driver.
 */
export async function reconstructCats(
  chia: SendFlowWasm,
  chain: ChainClient,
  keyring: KeyringEntry[],
  assetIdHex: string,
): Promise<unknown[]> {
  const assetId = chia.fromHex(assetIdHex.replace(/^0x/i, '').toLowerCase());
  const catPhs = keyring.map((k) => strip0x(chia.toHex(chia.catPuzzleHash(assetId, chia.fromHex(k.puzzleHashHex)))));
  const coins = await chain.unspentCoins(catPhs);
  const out: unknown[] = [];
  for (const coin of coins) {
    const parentSpend = await chain.getCoinSpend(strip0x(chia.toHex(coin.parentCoinInfo)));
    if (!parentSpend) continue;
    const clvm = new chia.Clvm();
    const puzzle = (clvm.deserialize(parentSpend.puzzleReveal) as unknown as { puzzle(): CatPuzzle }).puzzle();
    const children = puzzle.parseChildCats(parentSpend.coin, clvm.deserialize(parentSpend.solution)) ?? [];
    const wanted = strip0x(chia.toHex(coin.coinId()));
    const mine = children.find((c) => strip0x(chia.toHex(c.coin.coinId())) === wanted);
    if (mine) out.push(mine);
  }
  return out;
}

/** The Spends driver surface for a CAT send (reached via a focused cast from the send wasm). */
interface CatSpends {
  addXch(coin: unknown): void;
  addCat(cat: unknown): void;
  apply(actions: unknown[]): unknown;
  prepare(deltas: unknown): { pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; p2PuzzleHash(): Uint8Array; conditions(): unknown[] }>; insert(id: Uint8Array, spend: unknown): void; spend(): unknown };
}

/**
 * Prepare a CAT send: derive the ACTIVE index's keyring, reconstruct the wallet's CATs of `assetId`
 * at it, add XCH coins to cover the fee, and build via the driver (`Action.send(Id.existing(assetId),
 * …)`). Change/coin selection is the driver's; the summary echoes the requested transfer (the driver
 * + simulator guarantee the amounts). Does NOT sign or broadcast.
 *
 * `memo` (#105, optional): attach a plain-text note to the recipient's CREATE_COIN, same as
 * {@link prepareXchSend}'s `memo` — echoed straight into the summary (this path already echoes
 * `sent`/`change` rather than decoding them back from the built spend, so memo matches that rigor
 * level).
 */
export async function prepareCatSend(
  chia: SendFlowWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; assetId: string; recipient: string; amount: bigint; fee: bigint; activeIndex?: number; selectedCoinIds?: string[]; memo?: string; select?: SelectCoinsFn; cap?: number },
): Promise<PreparedSend> {
  const keyring = buildKeyring(chia, opts.seed, { index: opts.activeIndex ?? 0 });
  const keyByPuzzleHash = new Map<string, KeyPair>(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  type CatCandidate = { coin: { coinId(): Uint8Array; parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint } };
  const allCats = (await reconstructCats(chia, chain, keyring, opts.assetId)) as CatCandidate[];
  if (allCats.length === 0) throw new Error('NO_CAT_COINS: the wallet holds none of this token');
  // #417 — select the CAT coins high-value-first up to the cap (fee is paid separately in XCH, so the
  // selection target is the CAT amount only). A #91 hand-picked selection still overrides.
  const fundingIds = resolveFundingCoinIds(chia, {
    candidates: allCats,
    selectedCoinIds: opts.selectedCoinIds,
    select: opts.select,
    target: opts.amount,
    asset: { assetId: chia.fromHex(opts.assetId.replace(/^0x/i, '').toLowerCase()) },
    coinOf: (c) => toChip35Coin(c.coin),
    idOf: (c) => c.coin.coinId(),
    ...(opts.cap != null ? { cap: opts.cap } : {}),
  });
  const cats = filterSelected(chia, allCats, fundingIds, (c) => c.coin.coinId());
  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex)); // for the fee
  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);

  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, changePuzzleHash) as unknown as CatSpends;
  for (const c of xchCoins) spends.addXch(c);
  for (const c of cats) spends.addCat(c);
  const assetIdBytes = chia.fromHex(opts.assetId.replace(/^0x/i, '').toLowerCase());
  const idExisting = (chia.Id as unknown as { existing(a: Uint8Array): unknown }).existing(assetIdBytes);
  const memos = opts.memo ? buildPlainMemo(clvm, opts.memo) : undefined;
  const sendAction = (chia.Action as unknown as { send(id: unknown, ph: Uint8Array, amount: bigint, memos: unknown): unknown }).send(idExisting, destPuzzleHash, opts.amount, memos);
  const finished = spends.prepare(spends.apply([sendAction, chia.Action.fee(opts.fee)]));
  for (const ps of finished.pendingSpends()) {
    const key = keyByPuzzleHash.get(strip0x(chia.toHex(ps.p2PuzzleHash())));
    if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), (clvm as unknown as { standardSpend(pk: unknown, s: unknown): unknown; delegatedSpend(c: unknown[]): unknown }).standardSpend(key.pk, (clvm as unknown as { delegatedSpend(c: unknown[]): unknown }).delegatedSpend(ps.conditions())));
  }
  finished.spend();
  const coinSpends = clvm.coinSpends();
  const summary: SpendSummary = {
    asset: opts.assetId.replace(/^0x/i, '').toLowerCase(),
    sent: opts.amount.toString(),
    change: '0',
    fee: opts.fee.toString(),
    recipientPuzzleHashHex: strip0x(chia.toHex(destPuzzleHash)),
    coinCount: coinSpends.length,
    ...(opts.memo ? { memoText: opts.memo } : {}),
  };
  return { coinSpends, summary, secretKeys: keyring.map((k) => k.sk) };
}
