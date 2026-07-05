/**
 * Self-custody spend construction (§6 Send) — build an XCH transfer with the `Spends`/`Action`
 * driver, then decode a tamper-resistant summary FROM THE BUILT SPEND (never from caller text, §5.5).
 * Signing is `signing.ts`; broadcasting is a separate, user-approved step. Pure (injected wasm);
 * runs in the offscreen vault. Proven consensus-valid against the wasm simulator (send.test.ts).
 *
 * Flow: add the wallet's unspent coins → `apply([send, fee])` selects coins → for each selected
 * coin, provide its standard inner spend (`standardSpend` over the delegated conditions) keyed by the
 * coin's puzzle hash → finalize → decode CREATE_COINs into sent / change.
 */

import type { SigCoinSpend } from '@/offscreen/signing';

// ── Minimal structural surfaces of the wasm objects used here ────────────────────────────────────
interface WasmPk {
  toBytes(): Uint8Array;
}
interface WasmCoin {
  coinId(): Uint8Array;
}
interface WasmProgram {
  run(solution: WasmProgram, maxCost: bigint, mempoolMode: boolean): { value: WasmProgram };
  toList(): WasmProgram[] | undefined;
  parseCreateCoin(): { puzzleHash: Uint8Array; amount: bigint } | undefined;
}
interface WasmSpend {
  free?(): void;
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
interface WasmDeltas {
  free?(): void;
}
interface WasmSpends {
  addXch(coin: WasmCoin): void;
  apply(actions: unknown[]): WasmDeltas;
  prepare(deltas: WasmDeltas): WasmFinished;
}
interface WasmClvm {
  deserialize(bytes: Uint8Array): WasmProgram;
  delegatedSpend(conditions: WasmProgram[]): WasmSpend;
  standardSpend(syntheticKey: WasmPk, spend: WasmSpend): WasmSpend;
  coinSpends(): SigCoinSpend[];
}
export interface SendWasm {
  Clvm: new () => WasmClvm;
  Spends: new (clvm: WasmClvm, changePuzzleHash: Uint8Array) => WasmSpends;
  Action: { send(id: WasmId, puzzleHash: Uint8Array, amount: bigint, memos: undefined): unknown; fee(amount: bigint): unknown };
  Id: { xch(): WasmId };
  toHex(bytes: Uint8Array): string;
}
interface WasmId {
  free?(): void;
}

const MAX_COST = 11_000_000_000n;
const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** A signing keypair for one derived puzzle hash: the synthetic public + secret key. */
export interface KeyPair {
  pk: WasmPk;
}

/** Options for {@link buildXchSend}. `coins` are unspent XCH coins the wallet owns. */
export interface XchSendOpts {
  coins: WasmCoin[];
  /** Map of standard puzzle-hash hex → the synthetic key that owns it (for the inner spends). */
  keyByPuzzleHash: Map<string, KeyPair>;
  destPuzzleHash: Uint8Array;
  amount: bigint;
  fee: bigint;
  changePuzzleHash: Uint8Array;
}

/** A decoded, tamper-resistant spend summary (base units) read back from the built coin spends. */
export interface SpendSummary {
  /** `'XCH'` for native, or a CAT asset id (TAIL hex) for a token send. */
  asset: string;
  sent: string;
  change: string;
  fee: string;
  recipientPuzzleHashHex: string;
  coinCount: number;
}

/** The built (unsigned) spend: the coin spends to sign + a summary derived from them. */
export interface BuiltSpend {
  coinSpends: SigCoinSpend[];
  summary: SpendSummary;
}

/**
 * Build an XCH send. Selects coins via the driver, provides each selected coin's standard inner
 * spend (keyed by its puzzle hash — throws `MISSING_KEY` if the wallet doesn't own a selected coin),
 * finalizes, and decodes the CREATE_COINs into a sent/change summary. Does NOT sign or broadcast.
 */
export function buildXchSend(chia: SendWasm, opts: XchSendOpts): BuiltSpend {
  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, opts.changePuzzleHash);
  for (const coin of opts.coins) spends.addXch(coin);

  const deltas = spends.apply([
    chia.Action.send(chia.Id.xch(), opts.destPuzzleHash, opts.amount, undefined),
    chia.Action.fee(opts.fee),
  ]);
  const finished = spends.prepare(deltas);
  for (const ps of finished.pendingSpends()) {
    const key = opts.keyByPuzzleHash.get(strip0x(chia.toHex(ps.p2PuzzleHash())));
    if (!key) throw new Error('MISSING_KEY: a selected coin is not owned by this wallet');
    finished.insert(ps.coin().coinId(), clvm.standardSpend(key.pk, clvm.delegatedSpend(ps.conditions())));
  }
  finished.spend();
  const coinSpends = clvm.coinSpends();

  return { coinSpends, summary: decodeXchSummary(chia, clvm, coinSpends, opts) };
}

/** Decode sent (to the recipient) + change (everything else) from the built coin spends. */
function decodeXchSummary(chia: SendWasm, clvm: WasmClvm, coinSpends: SigCoinSpend[], opts: XchSendOpts): SpendSummary {
  const destHex = strip0x(chia.toHex(opts.destPuzzleHash));
  let sent = 0n;
  let change = 0n;
  for (const cs of coinSpends) {
    const conds = clvm.deserialize(cs.puzzleReveal).run(clvm.deserialize(cs.solution), MAX_COST, false).value.toList() ?? [];
    for (const c of conds) {
      const cc = c.parseCreateCoin();
      if (!cc) continue;
      if (strip0x(chia.toHex(cc.puzzleHash)) === destHex) sent += cc.amount;
      else change += cc.amount;
    }
  }
  return {
    asset: 'XCH',
    sent: sent.toString(),
    change: change.toString(),
    fee: opts.fee.toString(),
    recipientPuzzleHashHex: destHex,
    coinCount: coinSpends.length,
  };
}
