import { describe, it, expect } from 'vitest';
import {
  WALLETS_KEY,
  MAX_DERIVATION_INDEX,
  MAX_ACCOUNT_LABEL_LEN,
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
  setWalletPreviewAddress,
  shouldCachePreviewAddress,
  ensureAccounts,
  defaultAccountLabel,
  addAccount,
  renameAccount,
  removeAccount,
  activeAccountId,
  isWatchOnly,
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
      { id: 'a', label: 'A', createdAt: 1, active: false, activeIndex: 0, accounts: [{ id: 'a-acct-0', label: 'Account 1', index: 0 }] },
      { id: 'b', label: 'B', createdAt: 2, active: true, activeIndex: 7, accounts: [{ id: 'b-acct-0', label: 'Account 1', index: 7 }] },
    ]);
    // Metadata must NEVER carry the encrypted record.
    expect(meta[0]).not.toHaveProperty('record');
  });
});

describe('accounts (#95 — named derivation accounts under one seed)', () => {
  it('ensureAccounts synthesizes ONE default account at the wallet\'s current activeIndex when none exist', () => {
    const w = entry('a', 'A', 1, 3);
    const accounts = ensureAccounts(w);
    expect(accounts).toEqual([{ id: expect.any(String), label: 'Account 1', index: 3 }]);
  });

  it('ensureAccounts passes an existing accounts array through untouched', () => {
    const w = { ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Savings', index: 0 }] };
    expect(ensureAccounts(w)).toEqual([{ id: 'x', label: 'Savings', index: 0 }]);
  });

  it('defaultAccountLabel names the Nth account', () => {
    expect(defaultAccountLabel(1)).toBe('Account 1');
    expect(defaultAccountLabel(2)).toBe('Account 2');
  });

  it('addAccount appends a new account at the next unused index above the wallet\'s existing accounts', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }] }];
    const r = addAccount(w, 'a');
    const accounts = findWallet(r, 'a')?.accounts ?? [];
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({ label: 'Account 2', index: 1 });
  });

  it('addAccount picks an index above the HIGHEST existing account index, not just the count', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'One', index: 0 }, { id: 'y', label: 'Five', index: 5 }] }];
    const r = addAccount(w, 'a');
    const accounts = findWallet(r, 'a')?.accounts ?? [];
    expect(accounts[2].index).toBe(6);
  });

  it('addAccount accepts an explicit label, normalized', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }] }];
    const r = addAccount(w, 'a', '  Savings  ');
    expect(findWallet(r, 'a')?.accounts?.[1].label).toBe('Savings');
  });

  it('addAccount on an unknown wallet id is a no-op', () => {
    const w = [entry('a', 'A')];
    expect(addAccount(w, 'zzz')).toEqual(w);
  });

  it('renameAccount updates only the target account, immutably', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }, { id: 'y', label: 'Account 2', index: 1 }] }];
    const r = renameAccount(w, 'a', 'y', 'Trading');
    expect(findWallet(r, 'a')?.accounts?.find((acc) => acc.id === 'y')?.label).toBe('Trading');
    expect(findWallet(r, 'a')?.accounts?.find((acc) => acc.id === 'x')?.label).toBe('Account 1');
  });

  it('removeAccount drops the target account, immutably, refusing the last one', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }, { id: 'y', label: 'Account 2', index: 1 }] }];
    const r = removeAccount(w, 'a', 'y');
    expect(findWallet(r, 'a')?.accounts).toEqual([{ id: 'x', label: 'Account 1', index: 0 }]);

    const single = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }] }];
    expect(removeAccount(single, 'a', 'x')).toEqual(single); // last account survives, no-op
  });

  it('removeAccount re-homes the wallet activeIndex to a remaining account when the ACTIVE account is removed', () => {
    const w = [{ ...entry('a', 'A', 1, 5), accounts: [{ id: 'x', label: 'Account 1', index: 0 }, { id: 'y', label: 'Account 2', index: 5 }] }];
    const r = removeAccount(w, 'a', 'y');
    expect(findWallet(r, 'a')?.activeIndex).toBe(0);
  });

  it('removeAccount leaves activeIndex untouched when a NON-active account is removed', () => {
    const w = [{ ...entry('a', 'A', 1, 5), accounts: [{ id: 'x', label: 'Account 1', index: 0 }, { id: 'y', label: 'Account 2', index: 5 }] }];
    const r = removeAccount(w, 'a', 'x');
    expect(findWallet(r, 'a')?.activeIndex).toBe(5);
  });

  it('activeAccountId finds the account matching the wallet\'s activeIndex, else null', () => {
    const w = { ...entry('a', 'A', 1, 5), accounts: [{ id: 'x', label: 'Account 1', index: 0 }, { id: 'y', label: 'Account 2', index: 5 }] };
    expect(activeAccountId(w)).toBe('y');
    expect(activeAccountId({ ...w, activeIndex: 99 })).toBeNull();
  });

  it('MAX_ACCOUNT_LABEL_LEN clamps a too-long account label', () => {
    const w = [{ ...entry('a', 'A'), accounts: [{ id: 'x', label: 'Account 1', index: 0 }] }];
    const r = addAccount(w, 'a', 'x'.repeat(200));
    expect(findWallet(r, 'a')?.accounts?.[1].label).toHaveLength(MAX_ACCOUNT_LABEL_LEN);
  });
});

describe('watch-only wallets (#96)', () => {
  it('isWatchOnly is false for an ordinary custody wallet (no kind field, pre-#96)', () => {
    expect(isWatchOnly(entry('a', 'A'))).toBe(false);
  });

  it('isWatchOnly is true for a wallet explicitly marked kind: "watch"', () => {
    const w: WalletEntry = { ...entry('a', 'A'), kind: 'watch', watchPublicKeyHex: 'aa'.repeat(48), record: undefined };
    expect(isWatchOnly(w)).toBe(true);
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

describe('preview address caching (#176 — wallet switcher redesign)', () => {
  it('setWalletPreviewAddress sets only the target wallet, immutably', () => {
    const w = [entry('a', 'A'), entry('b', 'B')];
    const r = setWalletPreviewAddress(w, 'a', 'xch1aaa');
    expect(findWallet(r, 'a')?.previewAddress).toBe('xch1aaa');
    expect(findWallet(r, 'b')?.previewAddress).toBeUndefined();
    expect(findWallet(w, 'a')?.previewAddress).toBeUndefined(); // original untouched
  });

  it('setWalletPreviewAddress on an unknown wallet id is a no-op', () => {
    const w = [entry('a', 'A')];
    expect(setWalletPreviewAddress(w, 'zzz', 'xch1aaa')).toEqual(w);
  });

  it('toMeta carries previewAddress through when present, omits it when absent', () => {
    const w = [entry('a', 'A'), setWalletPreviewAddress([entry('b', 'B')], 'b', 'xch1bbb')[0]];
    const meta = toMeta(w, 'b');
    expect(meta[0].previewAddress).toBeUndefined();
    expect(meta[1].previewAddress).toBe('xch1bbb');
  });

  it('shouldCachePreviewAddress only caches the canonical index-0 address', () => {
    expect(shouldCachePreviewAddress(0, undefined, 'xch1aaa')).toBe(true);
    expect(shouldCachePreviewAddress(1, undefined, 'xch1aaa')).toBe(false); // not the canonical index
  });

  it('shouldCachePreviewAddress skips a no-op re-cache of the identical address', () => {
    expect(shouldCachePreviewAddress(0, 'xch1aaa', 'xch1aaa')).toBe(false);
    expect(shouldCachePreviewAddress(0, 'xch1aaa', 'xch1bbb')).toBe(true); // a real change still caches
  });

  it('shouldCachePreviewAddress rejects an empty/falsy address', () => {
    expect(shouldCachePreviewAddress(0, undefined, '')).toBe(false);
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
