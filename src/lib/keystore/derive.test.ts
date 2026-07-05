import { describe, it, expect, beforeAll } from 'vitest';
import { deriveAccount, deriveAccounts, masterFromSeed, WALLET_PATH_PREFIX, type ChiaWasm } from './derive';
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
