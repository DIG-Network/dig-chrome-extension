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

/** Derive the HD keyring (both schemes to `count`): standard puzzle hash → synthetic keys. */
export function buildKeyring(
  chia: SendFlowWasm,
  seed: Uint8Array,
  opts: { schemes?: Scheme[]; count: number },
): KeyringEntry[] {
  const schemes = opts.schemes ?? (['unhardened', 'hardened'] as Scheme[]);
  const master = chia.SecretKey.fromSeed(seed);
  try {
    const out: KeyringEntry[] = [];
    for (const scheme of schemes) {
      for (let i = 0; i < opts.count; i++) {
        const path = [...WALLET_PATH_PREFIX, i];
        const account = scheme === 'hardened' ? master.deriveHardenedPath(path) : master.deriveUnhardenedPath(path);
        const sk = account.deriveSynthetic();
        account.free?.();
        const pk = sk.publicKey();
        out.push({ puzzleHashHex: strip0x(chia.toHex(chia.standardPuzzleHash(pk))), pk, sk });
      }
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
}

/**
 * Prepare an XCH send: derive the keyring, fetch the wallet's unspent coins, decode the recipient,
 * and build the spend + summary. Does NOT sign or broadcast. Change returns to index-0 unhardened.
 */
export async function prepareXchSend(
  chia: SendFlowWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; recipient: string; amount: bigint; fee: bigint; gapLimit?: number; selectedCoinIds?: string[] },
): Promise<PreparedSend> {
  const keyring = buildKeyring(chia, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map<string, KeyPair>(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const allCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  const coins = filterSelected(chia, allCoins, opts.selectedCoinIds, (c) => c.coinId());
  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);
  const built = buildXchSend(chia, {
    coins,
    keyByPuzzleHash,
    destPuzzleHash,
    amount: opts.amount,
    fee: opts.fee,
    changePuzzleHash,
  });
  return { coinSpends: built.coinSpends, summary: built.summary, secretKeys: keyring.map((k) => k.sk) };
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
 * Prepare a CAT send: derive the keyring, reconstruct the wallet's CATs of `assetId`, add XCH coins
 * to cover the fee, and build via the driver (`Action.send(Id.existing(assetId), …)`). Change/coin
 * selection is the driver's; the summary echoes the requested transfer (the driver + simulator
 * guarantee the amounts). Does NOT sign or broadcast.
 */
export async function prepareCatSend(
  chia: SendFlowWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; assetId: string; recipient: string; amount: bigint; fee: bigint; gapLimit?: number; selectedCoinIds?: string[] },
): Promise<PreparedSend> {
  const keyring = buildKeyring(chia, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map<string, KeyPair>(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const allCats = await reconstructCats(chia, chain, keyring, opts.assetId);
  if (allCats.length === 0) throw new Error('NO_CAT_COINS: the wallet holds none of this token');
  const cats = filterSelected(chia, allCats as Array<{ coin: { coinId(): Uint8Array } }>, opts.selectedCoinIds, (c) => c.coin.coinId());
  const xchCoins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex)); // for the fee
  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);

  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, changePuzzleHash) as unknown as CatSpends;
  for (const c of xchCoins) spends.addXch(c);
  for (const c of cats) spends.addCat(c);
  const assetIdBytes = chia.fromHex(opts.assetId.replace(/^0x/i, '').toLowerCase());
  const idExisting = (chia.Id as unknown as { existing(a: Uint8Array): unknown }).existing(assetIdBytes);
  const sendAction = (chia.Action as unknown as { send(id: unknown, ph: Uint8Array, amount: bigint, memos: undefined): unknown }).send(idExisting, destPuzzleHash, opts.amount, undefined);
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
  };
  return { coinSpends, summary, secretKeys: keyring.map((k) => k.sk) };
}
