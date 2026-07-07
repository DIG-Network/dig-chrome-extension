import { describe, it, expect } from 'vitest';
import {
  WALLETS_KEY,
  MAX_DERIVATION_INDEX,
  migrateRegistry,
  addWallet,
  renameWallet,
  removeWallet,
  findWallet,
  activeRecord,
  nextActiveId,
  toMeta,
  normalizeLabel,
  defaultLabel,
  clampDerivationIndex,
  setWalletActiveIndex,
  type WalletEntry,
} from '@/lib/wallet-registry';
import type { Digwx1Record } from '@/lib/keystore/digwx1';

/** A minimal but structurally-valid DIGWX1 record stand-in (the registry never touches its crypto). */
function rec(label?: string, createdAt = 100): Digwx1Record {
  return {
    version: 1,
    magic: 'DIGWX1',
    kdf: { id: 'argon2id', memKiB: 65536, iters: 3, lanes: 4, salt: 'c2FsdA==' },
    cipher: { id: 'aes-256-gcm', nonce: 'bm9uY2U=' },
    ciphertext: 'Y2lwaGVy',
    createdAt,
    ...(label ? { label } : {}),
  };
}

function entry(id: string, label: string, createdAt = 100, activeIndex = 0): WalletEntry {
  return { id, label, record: rec(label, createdAt), createdAt, activeIndex };
}

describe('wallet-registry pure helpers (#90)', () => {
  it('WALLETS_KEY is the durable registry storage key', () => {
    expect(WALLETS_KEY).toBe('wallet.registry');
  });

  it('normalizeLabel trims, clamps to 40 chars, and falls back when blank', () => {
    expect(normalizeLabel('  Trading  ', 'x')).toBe('Trading');
    expect(normalizeLabel('', 'Wallet 2')).toBe('Wallet 2');
    expect(normalizeLabel('   ', 'Wallet 2')).toBe('Wallet 2');
    expect(normalizeLabel(undefined, 'Wallet 2')).toBe('Wallet 2');
    expect(normalizeLabel('x'.repeat(80), 'f')).toHaveLength(40);
  });

  it('defaultLabel names the Nth wallet', () => {
    expect(defaultLabel(1)).toBe('Wallet 1');
    expect(defaultLabel(3)).toBe('Wallet 3');
  });

  it('addWallet appends without mutating the input', () => {
    const a = [entry('a', 'A')];
    const b = addWallet(a, entry('b', 'B'));
    expect(b.map((w) => w.id)).toEqual(['a', 'b']);
    expect(a).toHaveLength(1); // immutable
  });

  it('findWallet locates by id (or undefined)', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    expect(findWallet(w, 'b')?.label).toBe('B');
    expect(findWallet(w, 'zzz')).toBeUndefined();
  });

  it('renameWallet updates only the target label, immutably', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    const r = renameWallet(w, 'a', 'Savings');
    expect(findWallet(r, 'a')?.label).toBe('Savings');
    expect(findWallet(r, 'b')?.label).toBe('B');
    expect(findWallet(w, 'a')?.label).toBe('A'); // original untouched
  });

  it('removeWallet drops the target, immutably', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    const r = removeWallet(w, 'a');
    expect(r.map((x) => x.id)).toEqual(['b']);
    expect(w).toHaveLength(2);
  });

  it('activeRecord returns the active entry record, else the first, else null', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    expect(activeRecord(w, 'b')?.label).toBe('B');
    expect(activeRecord(w, 'gone')?.label).toBe('A'); // falls back to first
    expect(activeRecord([], 'a')).toBeNull();
  });

  it('nextActiveId keeps the preferred id when it still exists, else picks the first', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    expect(nextActiveId(w, 'b')).toBe('b');
    expect(nextActiveId(w, 'gone')).toBe('a');
    expect(nextActiveId(w, null)).toBe('a');
    expect(nextActiveId([], 'a')).toBeNull();
  });

  it('toMeta strips the encrypted record, flags the active wallet, and carries its active index', () => {
    const w = [entry('a', 'A', 1, 0), entry('b', 'B', 2, 7)];
    const meta = toMeta(w, 'b');
    expect(meta).toEqual([
      { id: 'a', label: 'A', createdAt: 1, active: false, activeIndex: 0 },
      { id: 'b', label: 'B', createdAt: 2, active: true, activeIndex: 7 },
    ]);
    // Metadata must NEVER carry the encrypted record.
    expect(meta[0]).not.toHaveProperty('record');
  });
});

describe('active derivation index (#165 — single active index model)', () => {
  it('clampDerivationIndex floors, rejects negatives, and caps at MAX_DERIVATION_INDEX', () => {
    expect(clampDerivationIndex(5)).toBe(5);
    expect(clampDerivationIndex(5.9)).toBe(5);
    expect(clampDerivationIndex(-3)).toBe(0);
    expect(clampDerivationIndex(Number.MAX_SAFE_INTEGER)).toBe(MAX_DERIVATION_INDEX);
    expect(clampDerivationIndex(Number.NaN)).toBe(0);
    expect(clampDerivationIndex(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('setWalletActiveIndex updates only the target wallet, immutably, clamped', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    const r = setWalletActiveIndex(w, 'a', 5);
    expect(findWallet(r, 'a')?.activeIndex).toBe(5);
    expect(findWallet(r, 'b')?.activeIndex).toBe(0); // untouched
    expect(findWallet(w, 'a')?.activeIndex).toBe(0); // original untouched (immutable)
  });

  it('setWalletActiveIndex clamps a negative index to 0', () => {
    const w = [entry('a', 'A')];
    expect(findWallet(setWalletActiveIndex(w, 'a', -8), 'a')?.activeIndex).toBe(0);
  });

  it('setWalletActiveIndex on an unknown wallet id is a no-op', () => {
    const w = [entry('a', 'A')];
    expect(setWalletActiveIndex(w, 'zzz', 5)).toEqual(w);
  });
});

describe('migrateRegistry (#90)', () => {
  const genId = () => 'gen-id';

  it('empty everything → an empty registry (no wallet yet)', () => {
    const s = migrateRegistry({ legacyKeystore: null, wallets: null, activeId: null, now: 5, genId });
    expect(s).toEqual({ wallets: [], activeId: null, keystore: null });
  });

  it('migrates a legacy single keystore into a one-entry registry (ignoring the legacy label-as-id)', () => {
    const legacy = rec('main', 42);
    const s = migrateRegistry({ legacyKeystore: legacy, wallets: null, activeId: 'main', now: 7, genId });
    expect(s.wallets).toHaveLength(1);
    expect(s.wallets[0]).toMatchObject({ id: 'gen-id', label: 'main', createdAt: 42 });
    expect(s.activeId).toBe('gen-id'); // a fresh uuid, NOT the legacy 'main' label
    expect(s.keystore).toBe(legacy);
  });

  it('a legacy keystore with no label gets a default label', () => {
    const s = migrateRegistry({ legacyKeystore: rec(undefined, 9), wallets: null, activeId: null, now: 1, genId });
    expect(s.wallets[0].label).toBe('Wallet 1');
  });

  it('an existing registry passes through, repairing a stale/missing active id to the first entry', () => {
    const wallets = [entry('a', 'A'), entry('b', 'B')];
    expect(migrateRegistry({ legacyKeystore: null, wallets, activeId: 'b', now: 1, genId }).activeId).toBe('b');
    expect(migrateRegistry({ legacyKeystore: null, wallets, activeId: 'stale', now: 1, genId }).activeId).toBe('a');
    expect(migrateRegistry({ legacyKeystore: null, wallets, activeId: null, now: 1, genId }).activeId).toBe('a');
  });

  it('an existing registry surfaces the active record as the keystore mirror', () => {
    const wallets = [entry('a', 'A'), entry('b', 'B')];
    const s = migrateRegistry({ legacyKeystore: null, wallets, activeId: 'b', now: 1, genId });
    expect(s.keystore?.label).toBe('B');
  });

  it('a pre-#165 registry entry with no activeIndex field is normalized to 0', () => {
    // Simulates a wallet persisted before #165 shipped — its stored entry has no `activeIndex` at all.
    const legacyShapeWallets = [{ id: 'a', label: 'A', record: rec('A'), createdAt: 1 }] as WalletEntry[];
    const s = migrateRegistry({ legacyKeystore: null, wallets: legacyShapeWallets, activeId: 'a', now: 1, genId });
    expect(s.wallets[0].activeIndex).toBe(0);
  });

  it('a legacy single keystore migrates into a one-entry registry with activeIndex 0', () => {
    const s = migrateRegistry({ legacyKeystore: rec('main', 42), wallets: null, activeId: null, now: 1, genId });
    expect(s.wallets[0].activeIndex).toBe(0);
  });

  it('prefers an existing registry over a stale legacy blob (no double-migration)', () => {
    const wallets = [entry('a', 'A')];
    const s = migrateRegistry({ legacyKeystore: rec('old'), wallets, activeId: 'a', now: 1, genId });
    expect(s.wallets).toHaveLength(1);
    expect(s.wallets[0].id).toBe('a');
  });
});
