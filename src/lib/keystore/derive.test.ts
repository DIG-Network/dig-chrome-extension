import { describe, it, expect, beforeAll } from 'vitest';
import {
  deriveAccount,
  deriveAccounts,
  masterFromSeed,
  WALLET_PATH_PREFIX,
  masterPublicKeyFromHex,
  deriveWatchAccount,
  publicKeyFingerprint,
  deriveWalletSecretKeyHex,
  type ChiaWasm,
  type WatchWasm,
} from './derive';
import { mnemonicToSeed } from './bip39';
import { loadChiaWasmNode } from '@/test/chiaWasm';
import golden from './derive.golden.json';

// Golden HD-derivation parity vectors for the canonical all-zeros mnemonic. These are produced by
// chia_rs (via chia-wallet-sdk-wasm); dig-l1-wallet derives with the IDENTICAL chia_rs primitives
// (master_to_wallet_unhardened/hardened → derive_synthetic → StandardArgs::curry_tree_hash →
// bech32m Address), so parity across the extension, dig-l1-wallet, and Sage is by construction. The
// BIP-39 seed for this mnemonic is confirmed against the published test vector in bip39.test.ts.

let chia: ChiaWasm;
let seed: Uint8Array;

beforeAll(async () => {
  chia = await loadChiaWasmNode();
  seed = await mnemonicToSeed(golden.mnemonic);
});

describe('HD derivation parity vs dig-l1-wallet (golden vectors)', () => {
  it('exposes the Chia standard wallet path prefix m/12381/8444/2', () => {
    expect([...WALLET_PATH_PREFIX]).toEqual([12381, 8444, 2]);
  });

  it('matches golden UNHARDENED addresses + puzzle hashes across multiple indexes', () => {
    const master = masterFromSeed(chia, seed);
    try {
      for (const g of golden.unhardened) {
        const acct = deriveAccount(chia, master, g.index, 'unhardened');
        expect(acct.address, `unhardened[${g.index}] address`).toBe(g.address);
        expect(acct.puzzleHashHex, `unhardened[${g.index}] ph`).toBe(g.puzzleHashHex);
        expect(acct.syntheticPkHex, `unhardened[${g.index}] synPk`).toBe(g.syntheticPkHex);
      }
    } finally {
      master.free?.();
    }
  });

  it('matches golden HARDENED addresses + puzzle hashes across multiple indexes', () => {
    const master = masterFromSeed(chia, seed);
    try {
      for (const g of golden.hardened) {
        const acct = deriveAccount(chia, master, g.index, 'hardened');
        expect(acct.address, `hardened[${g.index}] address`).toBe(g.address);
        expect(acct.puzzleHashHex, `hardened[${g.index}] ph`).toBe(g.puzzleHashHex);
        expect(acct.syntheticPkHex, `hardened[${g.index}] synPk`).toBe(g.syntheticPkHex);
      }
    } finally {
      master.free?.();
    }
  });

  it('produces DIFFERENT keys for hardened vs unhardened at the same index (both must be scanned)', () => {
    const master = masterFromSeed(chia, seed);
    try {
      const u = deriveAccount(chia, master, 0, 'unhardened');
      const h = deriveAccount(chia, master, 0, 'hardened');
      expect(u.address).not.toBe(h.address);
      expect(u.puzzleHashHex).not.toBe(h.puzzleHashHex);
    } finally {
      master.free?.();
    }
  });

  it('deriveAccounts walks both schemes over an index range', () => {
    const accts = deriveAccounts(chia, seed, { count: 3 });
    expect(accts).toHaveLength(6); // 3 unhardened + 3 hardened
    const unh = accts.filter((a) => a.scheme === 'unhardened');
    const har = accts.filter((a) => a.scheme === 'hardened');
    expect(unh.map((a) => a.address)).toEqual(golden.unhardened.map((g) => g.address));
    expect(har.map((a) => a.address)).toEqual(golden.hardened.map((g) => g.address));
  });

  it('respects a custom scheme list and start index', () => {
    const accts = deriveAccounts(chia, seed, { schemes: ['unhardened'], start: 1, count: 2 });
    expect(accts.map((a) => a.index)).toEqual([1, 2]);
    expect(accts.map((a) => a.address)).toEqual([golden.unhardened[1].address, golden.unhardened[2].address]);
  });

  it('encodes valid xch bech32m addresses', () => {
    const master = masterFromSeed(chia, seed);
    try {
      expect(deriveAccount(chia, master, 0, 'unhardened').address).toMatch(/^xch1[0-9a-z]+$/);
    } finally {
      master.free?.();
    }
  });
});

/**
 * Public-key-only (watch-only, #96) derivation MUST reproduce the exact same UNHARDENED addresses a
 * full secret-key derivation would — that is the entire point of BLS unhardened HD derivation (it
 * commutes with taking the public key first). Hardened derivation is intentionally NOT exercised
 * here: it cannot be derived from a public key alone (§96 scope — watch-only covers unhardened only).
 */
describe('public-key-only derivation (#96 — watch-only wallets)', () => {
  it('deriveWatchAccount matches the golden UNHARDENED addresses using ONLY the master public key', () => {
    const master = masterFromSeed(chia, seed);
    const masterPkHex = chia.toHex(master.publicKey().toBytes()).replace(/^0x/i, '');
    master.free?.();
    const masterPk = masterPublicKeyFromHex(chia as unknown as WatchWasm, masterPkHex);
    try {
      for (const g of golden.unhardened) {
        const acct = deriveWatchAccount(chia as unknown as WatchWasm, masterPk, g.index);
        expect(acct.address, `watch unhardened[${g.index}] address`).toBe(g.address);
        expect(acct.puzzleHashHex, `watch unhardened[${g.index}] ph`).toBe(g.puzzleHashHex);
        expect(acct.syntheticPkHex, `watch unhardened[${g.index}] synPk`).toBe(g.syntheticPkHex);
        expect(acct.scheme).toBe('unhardened');
      }
    } finally {
      masterPk.free?.();
    }
  });

  it('masterPublicKeyFromHex accepts a 0x-prefixed hex string identically to a bare one', () => {
    const master = masterFromSeed(chia, seed);
    const masterPkHex = chia.toHex(master.publicKey().toBytes()).replace(/^0x/i, '');
    master.free?.();
    const a = masterPublicKeyFromHex(chia as unknown as WatchWasm, masterPkHex);
    const b = masterPublicKeyFromHex(chia as unknown as WatchWasm, `0x${masterPkHex}`);
    try {
      expect(deriveWatchAccount(chia as unknown as WatchWasm, a, 0).address).toBe(
        deriveWatchAccount(chia as unknown as WatchWasm, b, 0).address,
      );
    } finally {
      a.free?.();
      b.free?.();
    }
  });

  it('publicKeyFingerprint returns a positive integer identifying the key (Chia-convention fingerprint)', () => {
    const master = masterFromSeed(chia, seed);
    const masterPkHex = chia.toHex(master.publicKey().toBytes()).replace(/^0x/i, '');
    master.free?.();
    const masterPk = masterPublicKeyFromHex(chia as unknown as WatchWasm, masterPkHex);
    try {
      const fp = publicKeyFingerprint(masterPk);
      expect(Number.isInteger(fp)).toBe(true);
      expect(fp).toBeGreaterThan(0);
    } finally {
      masterPk.free?.();
    }
  });

  it('masterPublicKeyFromHex throws on a malformed key (wrong byte length for a BLS G1 point)', () => {
    expect(() => masterPublicKeyFromHex(chia as unknown as WatchWasm, 'ab'.repeat(10))).toThrow();
  });
});

/**
 * #96 — private-key export MUST hand back the PRE-synthetic account key (the convention Sage /
 * chia-blockchain / hardware wallets treat as "the wallet key" — they re-derive the synthetic offset
 * themselves). Verified by reconstructing the synthetic public key + address FROM the exported hex
 * and checking it lands on the SAME golden address `deriveAccount` produces directly.
 */
describe('deriveWalletSecretKeyHex (#96 — private-key export)', () => {
  // Widen to the SecretKey.fromBytes + fromHex surface the real wasm module also carries (beyond
  // the narrow `ChiaWasm` interface derive.ts declares). Computed lazily (inside each test) since
  // `chia` is only assigned once `beforeAll` has run.
  function wide() {
    return chia as unknown as {
      fromHex(h: string): Uint8Array;
      SecretKey: { fromBytes(b: Uint8Array): { deriveSynthetic(): { publicKey(): { toBytes(): Uint8Array } } } };
    };
  }

  it('the exported raw key re-derives to the golden UNHARDENED address at each index', () => {
    const master = masterFromSeed(chia, seed);
    try {
      for (const g of golden.unhardened.slice(0, 3)) {
        const hex = deriveWalletSecretKeyHex(chia, master, g.index, 'unhardened');
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
        const reconstructed = wide().SecretKey.fromBytes(wide().fromHex(hex));
        const syntheticPk = reconstructed.deriveSynthetic().publicKey();
        expect(chia.toHex(syntheticPk.toBytes()).replace(/^0x/i, '')).toBe(g.syntheticPkHex);
      }
    } finally {
      master.free?.();
    }
  });

  it('the exported raw key re-derives to the golden HARDENED address too', () => {
    const master = masterFromSeed(chia, seed);
    try {
      const g = golden.hardened[0];
      const hex = deriveWalletSecretKeyHex(chia, master, g.index, 'hardened');
      const reconstructed = wide().SecretKey.fromBytes(wide().fromHex(hex));
      const syntheticPk = reconstructed.deriveSynthetic().publicKey();
      expect(chia.toHex(syntheticPk.toBytes()).replace(/^0x/i, '')).toBe(g.syntheticPkHex);
    } finally {
      master.free?.();
    }
  });

  it('produces DIFFERENT raw keys for hardened vs unhardened at the same index', () => {
    const master = masterFromSeed(chia, seed);
    try {
      expect(deriveWalletSecretKeyHex(chia, master, 0, 'unhardened')).not.toBe(deriveWalletSecretKeyHex(chia, master, 0, 'hardened'));
    } finally {
      master.free?.();
    }
  });
});
