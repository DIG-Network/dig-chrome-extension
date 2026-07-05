/**
 * HD key derivation for the self-custody wallet — the Chia standard wallet path
 * `m/12381/8444/2/{index}`, derived in BOTH the unhardened and hardened forms (§5.7).
 *
 * The extension MUST reproduce the SAME wallet as `dig-l1-wallet` / Sage for a given seed. This is
 * the method-for-method mirror of `dig-l1-wallet::keys::derivation::derive_account`:
 *
 *   seed → SecretKey.fromSeed(seed)                         (master, = chia_rs SecretKey::from_seed)
 *        → deriveUnhardenedPath / deriveHardenedPath([12381,8444,2,index])
 *                                                           (= master_to_wallet_unhardened/hardened)
 *        → deriveSynthetic()                                (= DeriveSynthetic::derive_synthetic)
 *        → publicKey()
 *        → standardPuzzleHash(syntheticPk)                  (= StandardArgs::curry_tree_hash)
 *        → Address(puzzleHash, "xch").encode()              (= chia_wallet_sdk Address, bech32m)
 *
 * Because both sides call the identical `chia_rs` primitives, the derivations are byte-identical by
 * construction; the golden parity test pins concrete vectors to guard our wiring.
 *
 * Sage and the Chia reference wallet scan BOTH hardened and unhardened addresses, so a balance /
 * activity scan MUST cover both schemes — unhardened-only would make funds on hardened addresses
 * invisible. We do NOT use dig-keystore's `L1WalletBls` sign path (it double-derives — §5.7).
 *
 * The wasm is INJECTED (`ChiaWasm`) so this module is pure + testable: the Vitest golden test loads
 * a Node-instantiated `chia-wallet-sdk-wasm`, and the offscreen document passes the dynamically
 * imported wasm. Callers own wasm-handle lifetimes via the `free()` discipline documented per fn.
 */

/** The Chia standard wallet derivation path prefix (`m/12381/8444/2`); the index is appended. */
export const WALLET_PATH_PREFIX: readonly number[] = [12381, 8444, 2];

/** Which HD derivation form to use. Both are scanned (§5.7). */
export type Scheme = 'unhardened' | 'hardened';

/** Minimal structural surface of `chia-wallet-sdk-wasm` this module depends on. */
export interface WasmSecretKey {
  deriveUnhardenedPath(path: number[]): WasmSecretKey;
  deriveHardenedPath(path: number[]): WasmSecretKey;
  deriveSynthetic(): WasmSecretKey;
  publicKey(): WasmPublicKey;
  free?(): void;
}
export interface WasmPublicKey {
  toBytes(): Uint8Array;
  free?(): void;
}
export interface WasmAddress {
  encode(): string;
  free?(): void;
}
export interface ChiaWasm {
  SecretKey: { fromSeed(seed: Uint8Array): WasmSecretKey };
  Address: new (puzzleHash: Uint8Array, prefix: string) => WasmAddress;
  /** NOTE: `standardPuzzleHash` CONSUMES its PublicKey arg — never `free()` it afterward. */
  standardPuzzleHash(syntheticKey: WasmPublicKey): Uint8Array;
  toHex(bytes: Uint8Array): string;
}

/** A fully-derived account at one index/scheme. Hex fields are lower-case, no `0x` prefix. */
export interface DerivedAccount {
  index: number;
  scheme: Scheme;
  syntheticPkHex: string;
  puzzleHashHex: string;
  address: string;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/**
 * Build the master secret key from a 64-byte BIP-39 seed. The caller MUST `free()` the returned
 * handle when done deriving (it is reused across many indexes to avoid re-deriving the master).
 */
export function masterFromSeed(chia: ChiaWasm, seed: Uint8Array): WasmSecretKey {
  return chia.SecretKey.fromSeed(seed);
}

/**
 * Derive one account (address + puzzle hash + synthetic pubkey) at `index` under `scheme`.
 * `master` comes from {@link masterFromSeed}; it is NOT freed here (reused across indexes).
 * Intermediate secret keys ARE freed; the synthetic PublicKey is consumed by `standardPuzzleHash`.
 */
export function deriveAccount(
  chia: ChiaWasm,
  master: WasmSecretKey,
  index: number,
  scheme: Scheme,
  prefix = 'xch',
): DerivedAccount {
  const path = [...WALLET_PATH_PREFIX, index];
  const accountSk = scheme === 'hardened' ? master.deriveHardenedPath(path) : master.deriveUnhardenedPath(path);
  const syntheticSk = accountSk.deriveSynthetic();
  accountSk.free?.();
  const syntheticPk = syntheticSk.publicKey();
  syntheticSk.free?.();
  const syntheticPkHex = strip0x(chia.toHex(syntheticPk.toBytes()));
  const puzzleHash = chia.standardPuzzleHash(syntheticPk); // consumes syntheticPk
  const puzzleHashHex = strip0x(chia.toHex(puzzleHash));
  const addr = new chia.Address(puzzleHash, prefix);
  const address = addr.encode();
  addr.free?.();
  return { index, scheme, syntheticPkHex, puzzleHashHex, address };
}

/**
 * Derive a contiguous block of accounts for the given schemes and index range — the primitive an
 * HD balance/activity scan iterates (each scheme walked to its own gap limit). Frees the master.
 */
export function deriveAccounts(
  chia: ChiaWasm,
  seed: Uint8Array,
  opts: { schemes?: Scheme[]; start?: number; count: number; prefix?: string },
): DerivedAccount[] {
  const schemes = opts.schemes ?? (['unhardened', 'hardened'] as Scheme[]);
  const start = opts.start ?? 0;
  const master = masterFromSeed(chia, seed);
  try {
    const out: DerivedAccount[] = [];
    for (const scheme of schemes) {
      for (let i = start; i < start + opts.count; i++) {
        out.push(deriveAccount(chia, master, i, scheme, opts.prefix));
      }
    }
    return out;
  } finally {
    master.free?.();
  }
}

/* c8 ignore start — production wasm loader: the bundler-target `.wasm` cannot instantiate under the
   jsdom test env, so the golden test injects a Node-instantiated wasm instead. This dynamic import
   is exercised only in the offscreen document at runtime. */
let _chia: Promise<ChiaWasm> | null = null;
/** Lazily import the real `chia-wallet-sdk-wasm` (offscreen-document runtime only). */
export function loadChiaWasm(): Promise<ChiaWasm> {
  if (!_chia) _chia = import('chia-wallet-sdk-wasm') as unknown as Promise<ChiaWasm>;
  return _chia;
}
/* c8 ignore stop */
