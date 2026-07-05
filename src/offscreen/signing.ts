/**
 * Self-custody spend signing (§5.8) — the signing core proven by the Phase-1 spike. The shipped
 * `chia-wallet-sdk-wasm` has every primitive needed; NO bespoke crypto crate is required, for own
 * OR foreign spends:
 *
 *   - Required signatures are reconstructed from ANY coin spends (own or dApp-supplied) by running
 *     each puzzle against its solution and parsing the output conditions for AGG_SIG_ME /
 *     AGG_SIG_UNSAFE (`Program.run().value.toList()` + `parseAggSigMe()` / `parseAggSigUnsafe()`).
 *   - The consensus message for an AGG_SIG_ME is `rawMessage ‖ coinId ‖ AGG_SIG_ME_ADDITIONAL_DATA`
 *     (the network genesis — mainnet `ccd5bb…`); AGG_SIG_UNSAFE signs the raw message as-is.
 *   - Sign each with the matching key (`SecretKey.sign`) and `Signature.aggregate`.
 *
 * Proven end-to-end against the wasm simulator (a reconstructed signature is accepted by
 * `Simulator.newTransaction`) — see signing.test.ts. Pure (injected wasm); runs in the offscreen
 * document, which alone holds the key. This module only BUILDS + VALIDATES signatures; broadcasting
 * is a separate, user-approved step.
 */

/** Mainnet AGG_SIG_ME additional data (the mainnet genesis challenge). */
export const MAINNET_AGG_SIG_ME =
  'ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb';
/** Testnet11 AGG_SIG_ME additional data (also the wasm simulator's genesis). */
export const TESTNET11_AGG_SIG_ME =
  '37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615';

/** CLVM max cost when running a puzzle to read its output conditions. */
const MAX_COST = 11_000_000_000n;

// ── Minimal structural surfaces of the wasm objects this module touches ──────────────────────────
interface SigPublicKey {
  toBytes(): Uint8Array;
  free?(): void;
}
interface SigSignature {
  free?(): void;
}
export interface SigSecretKey {
  publicKey(): SigPublicKey;
  sign(message: Uint8Array): SigSignature;
  deriveSynthetic(): SigSecretKey;
  free?(): void;
}
interface SigAggSig {
  publicKey: SigPublicKey;
  message: Uint8Array;
}
interface SigProgram {
  run(solution: SigProgram, maxCost: bigint, mempoolMode: boolean): { value: SigProgram };
  toList(): SigProgram[] | undefined;
  parseAggSigMe(): SigAggSig | undefined;
  parseAggSigUnsafe(): SigAggSig | undefined;
  free?(): void;
}
export interface SigCoinSpend {
  coin: { coinId(): Uint8Array };
  puzzleReveal: Uint8Array;
  solution: Uint8Array;
}
interface SigClvm {
  deserialize(bytes: Uint8Array): SigProgram;
}
export interface SigningWasm {
  /** `deserialize` is a `Clvm` method, so the module instantiates one to parse puzzle/solution. */
  Clvm: new () => SigClvm;
  fromHex(hex: string): Uint8Array;
  toHex(bytes: Uint8Array): string;
  Signature: { aggregate(signatures: SigSignature[]): SigSignature };
}

/** One required BLS signature: the signer's public key (hex) + the exact message to sign. */
export interface RequiredSig {
  publicKeyHex: string;
  message: Uint8Array;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Reconstruct every required signature from a set of coin spends (own or foreign). Runs each
 * puzzle+solution, reads the output conditions, and collects AGG_SIG_ME (message augmented with the
 * coin id + `additionalDataHex`) and AGG_SIG_UNSAFE (raw message) signature requirements.
 */
export function requiredSignatures(
  chia: SigningWasm,
  coinSpends: SigCoinSpend[],
  additionalDataHex: string,
): RequiredSig[] {
  const additional = chia.fromHex(strip0x(additionalDataHex));
  const clvm = new chia.Clvm();
  const out: RequiredSig[] = [];
  for (const cs of coinSpends) {
    const coinId = cs.coin.coinId();
    const puzzle = clvm.deserialize(cs.puzzleReveal);
    const solution = clvm.deserialize(cs.solution);
    const conditions = puzzle.run(solution, MAX_COST, false).value.toList() ?? [];
    for (const cond of conditions) {
      const me = cond.parseAggSigMe();
      if (me) {
        out.push({ publicKeyHex: strip0x(chia.toHex(me.publicKey.toBytes())), message: concat(me.message, coinId, additional) });
        continue;
      }
      const unsafe = cond.parseAggSigUnsafe();
      if (unsafe) {
        out.push({ publicKeyHex: strip0x(chia.toHex(unsafe.publicKey.toBytes())), message: unsafe.message });
      }
    }
  }
  return out;
}

/** Index candidate secret keys by their public key hex, including each key's synthetic derivation. */
function keyIndex(chia: SigningWasm, secretKeys: SigSecretKey[]): Map<string, SigSecretKey> {
  const map = new Map<string, SigSecretKey>();
  for (const sk of secretKeys) {
    map.set(strip0x(chia.toHex(sk.publicKey().toBytes())), sk);
    const syn = sk.deriveSynthetic();
    map.set(strip0x(chia.toHex(syn.publicKey().toBytes())), syn);
  }
  return map;
}

/**
 * Sign a set of coin spends and return the aggregated BLS signature for a `SpendBundle`. Matches
 * each required public key to one of the provided secret keys (raw or its synthetic form); throws
 * `MISSING_KEY` if a required signer is not among them (so a foreign spend we can't fully sign fails
 * loudly rather than producing an invalid bundle).
 */
export function signCoinSpends(
  chia: SigningWasm,
  coinSpends: SigCoinSpend[],
  secretKeys: SigSecretKey[],
  additionalDataHex: string,
): SigSignature {
  const required = requiredSignatures(chia, coinSpends, additionalDataHex);
  const keys = keyIndex(chia, secretKeys);
  const sigs: SigSignature[] = [];
  for (const req of required) {
    const sk = keys.get(req.publicKeyHex);
    if (!sk) throw new Error(`MISSING_KEY: no secret key for required signer ${req.publicKeyHex.slice(0, 12)}…`);
    sigs.push(sk.sign(req.message));
  }
  return chia.Signature.aggregate(sigs);
}
