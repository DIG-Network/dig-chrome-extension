import { describe, it, expect, vi } from 'vitest';
import {
  purgeWalletFromRegistry,
  applyScopedPurge,
  TEARDOWN_LOCAL_KEYS,
  TEARDOWN_SESSION_KEYS,
  type ScopedPurgeDeps,
} from './node-purge';
import type { WalletEntry } from './wallet-registry';
import type { Digwx1Record } from './keystore/digwx1';

const rec = (id: string): Digwx1Record => ({ label: id }) as unknown as Digwx1Record;
const entry = (id: string): WalletEntry => ({ id, label: id, record: rec(id), createdAt: 0, activeIndex: 0 });

describe('teardown key sets', () => {
  it('the wholesale-teardown local keys are exactly the keystore mirror, the registry, and the active-id', () => {
    expect(TEARDOWN_LOCAL_KEYS).toEqual(['wallet.keystore', 'wallet.registry', 'wallet.activeId']);
  });
  it('the teardown session key is the unlock-expiry', () => {
    expect(TEARDOWN_SESSION_KEYS).toEqual(['wallet.unlockExpiry']);
  });
});

describe('purgeWalletFromRegistry (PURE scoped decision — the fund-loss fix)', () => {
  it('removes ONLY the migrated wallet; the others (with their records) survive', () => {
    const res = purgeWalletFromRegistry([entry('A'), entry('B'), entry('C')], 'A', 'A');
    expect(res.remaining.map((w) => w.id)).toEqual(['B', 'C']);
    expect(res.remaining.every((w) => !!w.record)).toBe(true);
    expect(res.fullTeardown).toBe(false);
  });

  it('recomputes the active id + keystore mirror over what remains when the ACTIVE wallet is purged', () => {
    const res = purgeWalletFromRegistry([entry('A'), entry('B')], 'A', 'A');
    expect(res.activeId).toBe('B');
    expect(res.keystoreMirror).toEqual(rec('B'));
  });

  it('keeps the active id when a NON-active wallet is purged', () => {
    const res = purgeWalletFromRegistry([entry('A'), entry('B')], 'A', 'B');
    expect(res.remaining.map((w) => w.id)).toEqual(['A']);
    expect(res.activeId).toBe('A');
    expect(res.keystoreMirror).toEqual(rec('A'));
    expect(res.fullTeardown).toBe(false);
  });

  it('the LAST wallet → full teardown (nothing remains, mirror null)', () => {
    const res = purgeWalletFromRegistry([entry('A')], 'A', 'A');
    expect(res.remaining).toEqual([]);
    expect(res.fullTeardown).toBe(true);
    expect(res.activeId).toBeNull();
    expect(res.keystoreMirror).toBeNull();
  });

  it('purging an absent id is a no-op (idempotent re-run)', () => {
    const res = purgeWalletFromRegistry([entry('A'), entry('B')], 'A', 'GONE');
    expect(res.remaining.map((w) => w.id)).toEqual(['A', 'B']);
    expect(res.fullTeardown).toBe(false);
  });
});

describe('applyScopedPurge (executor)', () => {
  function fakeDeps() {
    const set: Array<Record<string, unknown>> = [];
    const removedLocal: string[][] = [];
    const removedSession: string[][] = [];
    const deps: ScopedPurgeDeps = {
      setLocal: vi.fn(async (items) => {
        set.push(items);
      }),
      removeLocal: vi.fn(async (keys) => {
        removedLocal.push([...keys]);
      }),
      removeSession: vi.fn(async (keys) => {
        removedSession.push([...keys]);
      }),
      zeroizeVault: vi.fn(async () => {}),
    };
    return { deps, set, removedLocal, removedSession };
  }

  it('full teardown removes every key-material key wholesale + zeroizes the vault', async () => {
    const { deps, removedLocal, removedSession } = fakeDeps();
    await applyScopedPurge({ remaining: [], activeId: null, keystoreMirror: null, fullTeardown: true }, deps);
    expect(deps.zeroizeVault).toHaveBeenCalledOnce();
    expect(removedLocal).toEqual([[...TEARDOWN_LOCAL_KEYS]]);
    expect(removedSession).toEqual([[...TEARDOWN_SESSION_KEYS]]);
    expect(deps.setLocal).not.toHaveBeenCalled(); // the whole registry key is REMOVED, never rewritten
  });

  it('partial purge REWRITES the registry (never removes it) + updates the mirror + clears the unlock window', async () => {
    const { deps, set, removedLocal, removedSession } = fakeDeps();
    const remaining = [entry('B'), entry('C')];
    await applyScopedPurge({ remaining, activeId: 'B', keystoreMirror: rec('B'), fullTeardown: false }, deps);
    // The registry is written back minus A — NOT removed.
    expect(set).toContainEqual({ 'wallet.registry': remaining, 'wallet.activeId': 'B' });
    expect(set).toContainEqual({ 'wallet.keystore': rec('B') });
    expect(removedLocal).not.toContainEqual(['wallet.registry']); // NEVER wholesale-removes the registry here
    expect(removedSession).toEqual([[...TEARDOWN_SESSION_KEYS]]); // unlock window cleared
  });

  it('partial purge with no active custody record removes the keystore mirror', async () => {
    const { deps, removedLocal } = fakeDeps();
    const remaining = [{ id: 'W', label: 'W', createdAt: 0, activeIndex: 0, kind: 'watch' as const }];
    await applyScopedPurge({ remaining, activeId: 'W', keystoreMirror: null, fullTeardown: false }, deps);
    expect(removedLocal).toContainEqual(['wallet.keystore']);
  });

  it('never blocks when the offscreen zeroize throws (best-effort)', async () => {
    const { deps } = fakeDeps();
    (deps.zeroizeVault as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('gone'));
    await expect(
      applyScopedPurge({ remaining: [], activeId: null, keystoreMirror: null, fullTeardown: true }, deps),
    ).resolves.toBeUndefined();
    expect(deps.removeLocal).toHaveBeenCalled();
  });
});
