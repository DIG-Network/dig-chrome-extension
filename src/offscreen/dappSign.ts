/**
 * dApp foreign-spend decode + sign (§5.5, #56) — the tamper-resistant core behind the SW-summoned
 * approval window. A webpage/dApp calls `window.chia.signCoinSpends` (or `signMessage`) with data it
 * built; the custody wallet MUST show the user WHAT it will authorize — decoded FROM THE BUILT SPEND,
 * never from page-supplied text — and, on approval, sign in the offscreen vault (the sole holder of
 * the key). Pure (injected wasm); reuses the proven §5.8 signing core (`signing.ts`). Foreign spends
 * are signed exactly like own spends — no bespoke crypto crate (the spike proved this).
 *
 * A signature reconstructed here is accepted by the wasm Simulator's `newTransaction` (dappSign.test)
 * — the same authoritative bar as the send/offers money paths.
 */

import {
  requiredSignatures,
  type SigningWasm,
  type SigCoinSpend,
  type SigSecretKey,
} from '@/offscreen/signing';

/** CLVM max cost when running a puzzle to read its output conditions. */
const MAX_COST = 11_000_000_000n;

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** A dApp-supplied coin (CHIP-0002 / Chia JSON — hex fields, snake_case or camelCase accepted). */
export interface WireCoin {
  parent_coin_info?: string;
  parentCoinInfo?: string;
  puzzle_hash?: string;
  puzzleHash?: string;
  amount: string | number;
}
/** A dApp-supplied coin spend on the wire. */
export interface WireCoinSpend {
  coin: WireCoin;
  puzzle_reveal?: string;
  puzzleReveal?: string;
  solution: string;
}

// ── Minimal structural surfaces of the wasm objects this module constructs/reads ──────────────────
interface WasmCoin {
  coinId(): Uint8Array;
  puzzleHash: Uint8Array;
  amount: bigint;
  free?(): void;
}
interface DecodeProgram {
  run(solution: DecodeProgram, maxCost: bigint, mempoolMode: boolean): { value: DecodeProgram };
  toList(): DecodeProgram[] | undefined;
  parseCreateCoin(): { puzzleHash: Uint8Array; amount: bigint } | undefined;
  free?(): void;
}
interface DecodeClvm {
  deserialize(bytes: Uint8Array): DecodeProgram;
}
interface WasmSignature {
  toBytes(): Uint8Array;
  free?(): void;
}

/** The wasm surface this module needs: the signing core plus `Coin`/`CoinSpend` constructors. */
export interface DappSignWasm extends SigningWasm {
  Coin: new (parentCoinInfo: Uint8Array, puzzleHash: Uint8Array, amount: bigint) => WasmCoin;
  CoinSpend: new (coin: WasmCoin, puzzleReveal: Uint8Array, solution: Uint8Array) => SigCoinSpend;
}

/** One reconstructed input coin (for the decoded summary). */
export interface ReconstructedInput {
  coinIdHex: string;
  puzzleHashHex: string;
  amount: bigint;
}

/**
 * A tamper-resistant summary decoded from the BUILT spend (§5.5) — everything the approval window
 * shows is derived here from the actual coin spends, never from page text. Amounts are XCH-layer
 * mojos as decimal strings; `feeMojos`/`sendingMojos`/`changeMojos` are trustworthy for standard XCH
 * spends (`allInputsSelf` true), and the itemized `inputs`/`outputs` are always exact.
 */
export interface DappSpendSummary {
  coinCount: number;
  inputs: { coinId: string; puzzleHash: string; amount: string; isSelf: boolean }[];
  outputs: { puzzleHash: string; amount: string; isSelf: boolean }[];
  /** Reserved fee = Σ input mojos − Σ output mojos (clamped ≥ 0). Trustworthy iff `allInputsSelf`. */
  feeMojos: string;
  /** Σ of output amounts to puzzle hashes the wallet does NOT own (value leaving the wallet). */
  sendingMojos: string;
  /** Σ of output amounts back to the wallet's own puzzle hashes (change / self-transfer). */
  changeMojos: string;
  /** True iff every input coin is owned by this wallet (so the mojo view is a plain XCH spend). */
  allInputsSelf: boolean;
  /** Distinct public keys (hex) the spend requires a signature from. */
  requiredSigners: string[];
  /** How many required signers this wallet can satisfy (raw or synthetic key match). */
  ownedSigners: number;
}

/** Read a wire field by either its camelCase or snake_case name; throws if absent. */
function field(obj: Record<string, unknown>, camel: string, snake: string): string {
  const v = obj[camel] ?? obj[snake];
  if (v == null) throw new Error(`BAD_COIN_SPEND: missing ${snake}`);
  return String(v);
}

/**
 * Rebuild wasm `CoinSpend`s from dApp-supplied wire coin spends (hex fields). Returns the wasm coin
 * spends (to run/sign) plus the decoded input coins (id + puzzle hash + amount) for the summary.
 */
export function reconstructCoinSpends(
  chia: DappSignWasm,
  wire: WireCoinSpend[],
): { coinSpends: SigCoinSpend[]; inputs: ReconstructedInput[] } {
  const coinSpends: SigCoinSpend[] = [];
  const inputs: ReconstructedInput[] = [];
  for (const w of wire) {
    if (!w || !w.coin) throw new Error('BAD_COIN_SPEND: missing coin');
    const coinRec = w.coin as unknown as Record<string, unknown>;
    const parent = chia.fromHex(strip0x(field(coinRec, 'parentCoinInfo', 'parent_coin_info')));
    const phHex = strip0x(field(coinRec, 'puzzleHash', 'puzzle_hash'));
    const ph = chia.fromHex(phHex);
    const amount = BigInt(w.coin.amount);
    const coin = new chia.Coin(parent, ph, amount);
    const puzzleReveal = chia.fromHex(strip0x(field(w as unknown as Record<string, unknown>, 'puzzleReveal', 'puzzle_reveal')));
    const solution = chia.fromHex(strip0x(w.solution));
    coinSpends.push(new chia.CoinSpend(coin, puzzleReveal, solution));
    inputs.push({ coinIdHex: strip0x(chia.toHex(coin.coinId())), puzzleHashHex: phHex, amount });
  }
  return { coinSpends, inputs };
}

/**
 * Decode a tamper-resistant summary from dApp-supplied coin spends. `ownPuzzleHashesHex` /
 * `ownPublicKeysHex` are the wallet's derived HD sets (both schemes) so outputs/inputs are classified
 * self-vs-external and the required signers are matched against what this wallet can sign.
 */
export function decodeDappSpend(
  chia: DappSignWasm,
  wire: WireCoinSpend[],
  ownPuzzleHashesHex: string[],
  additionalDataHex: string,
  ownPublicKeysHex: string[] = [],
): DappSpendSummary {
  const own = new Set(ownPuzzleHashesHex.map(strip0x));
  const ownPk = new Set(ownPublicKeysHex.map(strip0x));
  const { coinSpends, inputs } = reconstructCoinSpends(chia, wire);

  const clvm = new chia.Clvm() as unknown as DecodeClvm;
  let totalOut = 0n;
  let sending = 0n;
  let change = 0n;
  const outputs: DappSpendSummary['outputs'] = [];
  for (const cs of coinSpends) {
    const puzzle = clvm.deserialize(cs.puzzleReveal);
    const solution = clvm.deserialize(cs.solution);
    const conds = puzzle.run(solution, MAX_COST, false).value.toList() ?? [];
    for (const c of conds) {
      const cc = c.parseCreateCoin();
      if (!cc) continue;
      const phHex = strip0x(chia.toHex(cc.puzzleHash));
      const isSelf = own.has(phHex);
      totalOut += cc.amount;
      if (isSelf) change += cc.amount;
      else sending += cc.amount;
      outputs.push({ puzzleHash: phHex, amount: cc.amount.toString(), isSelf });
    }
  }

  let totalIn = 0n;
  const inputRows = inputs.map((i) => {
    totalIn += i.amount;
    return { coinId: i.coinIdHex, puzzleHash: i.puzzleHashHex, amount: i.amount.toString(), isSelf: own.has(i.puzzleHashHex) };
  });
  const allInputsSelf = inputRows.length > 0 && inputRows.every((i) => i.isSelf);
  const fee = totalIn - totalOut;

  const reqs = requiredSignatures(chia, coinSpends, additionalDataHex);
  const requiredSigners = [...new Set(reqs.map((r) => strip0x(r.publicKeyHex)))];
  const ownedSigners = requiredSigners.filter((pk) => ownPk.has(pk)).length;

  return {
    coinCount: coinSpends.length,
    inputs: inputRows,
    outputs,
    feeMojos: (fee > 0n ? fee : 0n).toString(),
    sendingMojos: sending.toString(),
    changeMojos: change.toString(),
    allInputsSelf,
    requiredSigners,
    ownedSigners,
  };
}

/**
 * Sign dApp-supplied coin spends with the wallet's keys and return the aggregated BLS signature (hex).
 * Reuses the proven §5.8 signer, so a required signer with no matching key fails loudly (`MISSING_KEY`)
 * rather than emitting an invalid bundle. Broadcasting stays the dApp's job — this returns the sig.
 */
export function signDappCoinSpends(
  chia: DappSignWasm,
  wire: WireCoinSpend[],
  secretKeys: SigSecretKey[],
  additionalDataHex: string,
): { signatureHex: string } {
  const { coinSpends } = reconstructCoinSpends(chia, wire);
  const required = requiredSignatures(chia, coinSpends, additionalDataHex);
  const keys = keyIndex(chia, secretKeys);
  const sigs: unknown[] = [];
  for (const req of required) {
    const sk = keys.get(strip0x(req.publicKeyHex));
    if (!sk) throw new Error(`MISSING_KEY: no secret key for required signer ${req.publicKeyHex.slice(0, 12)}…`);
    sigs.push(sk.sign(req.message));
  }
  const agg = chia.Signature.aggregate(sigs as Parameters<typeof chia.Signature.aggregate>[0]) as unknown as WasmSignature;
  return { signatureHex: strip0x(chia.toHex(agg.toBytes())) };
}

/**
 * Sign an arbitrary message (AGG_SIG_UNSAFE-style — the raw bytes are signed) with the wallet key.
 * When `requestedPublicKeyHex` is given, the wallet MUST own that key (raw or synthetic) or it fails
 * `MISSING_KEY`; otherwise the first key's raw public key signs. Returns the signature + signer key.
 */
export function signMessageCustody(
  chia: DappSignWasm,
  message: Uint8Array,
  secretKeys: SigSecretKey[],
  requestedPublicKeyHex?: string,
): { signatureHex: string; publicKeyHex: string } {
  if (secretKeys.length === 0) throw new Error('MISSING_KEY: the wallet holds no keys');
  const keys = keyIndex(chia, secretKeys);
  let signer: SigSecretKey;
  let publicKeyHex: string;
  if (requestedPublicKeyHex) {
    const want = strip0x(requestedPublicKeyHex);
    const sk = keys.get(want);
    if (!sk) throw new Error(`MISSING_KEY: the wallet does not own ${want.slice(0, 12)}…`);
    signer = sk;
    publicKeyHex = want;
  } else {
    signer = secretKeys[0];
    publicKeyHex = strip0x(chia.toHex(signer.publicKey().toBytes()));
  }
  const sig = signer.sign(message) as unknown as WasmSignature;
  return { signatureHex: strip0x(chia.toHex(sig.toBytes())), publicKeyHex };
}

/** Index candidate secret keys by public key hex, including each key's synthetic derivation. */
function keyIndex(chia: DappSignWasm, secretKeys: SigSecretKey[]): Map<string, SigSecretKey> {
  const map = new Map<string, SigSecretKey>();
  for (const sk of secretKeys) {
    map.set(strip0x(chia.toHex(sk.publicKey().toBytes())), sk);
    const syn = sk.deriveSynthetic();
    map.set(strip0x(chia.toHex(syn.publicKey().toBytes())), syn);
  }
  return map;
}
