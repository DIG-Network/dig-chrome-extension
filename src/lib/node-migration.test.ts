import { describe, it, expect, vi } from 'vitest';
import {
  runSeedMigration,
  nodeProvesCanSign,
  cutoverEligibility,
  MigrationAbortedError,
  type MigrationDeps,
  type LocalSeedForMigration,
} from './node-migration';
import type { NodeCustodyStatus } from './node-custody';
import { purgeWalletFromRegistry } from './node-purge';
import type { WalletEntry } from './wallet-registry';
import type { Digwx1Record } from './keystore/digwx1';

const SEED: LocalSeedForMigration = { walletId: 'A', mnemonic: 'abandon '.repeat(23) + 'art', expectedAddress: 'xch1self' };

/** A scriptable node whose `wallet.status` reads a mutable state; import/unlock transition it. */
function fakeNode(initial: NodeCustodyStatus, opts: { importAddress?: string; unlockAddress?: string } = {}) {
  let status: NodeCustodyStatus = { ...initial };
  const importAddress = opts.importAddress ?? SEED.expectedAddress;
  const unlockAddress = opts.unlockAddress ?? SEED.expectedAddress;
  return {
    nodeStatus: vi.fn(async () => ({ ...status })),
    nodeImport: vi.fn(async (_m: string, _p: string) => {
      status = { state: 'unlocked', address: importAddress };
      return { address: importAddress };
    }),
    nodeUnlock: vi.fn(async (_p: string) => {
      status = { state: 'unlocked', address: unlockAddress };
      return { address: unlockAddress };
    }),
  };
}

function deps(over: Partial<MigrationDeps>): MigrationDeps {
  return {
    getLocalSeed: async () => SEED,
    nodeStatus: async () => ({ state: 'none', address: null }),
    nodeImport: async () => ({ address: SEED.expectedAddress }),
    nodeUnlock: async () => ({ address: SEED.expectedAddress }),
    purgeWallet: vi.fn(async () => {}),
    ...over,
  };
}

const rec = (id: string): Digwx1Record => ({ label: id }) as unknown as Digwx1Record;
const entry = (id: string): WalletEntry => ({ id, label: id, record: rec(id), createdAt: 0, activeIndex: 0 });

describe('nodeProvesCanSign (the verify gate)', () => {
  it('true only when unlocked AND the address matches', () => {
    expect(nodeProvesCanSign({ state: 'unlocked', address: 'xch1self' }, SEED)).toBe(true);
  });
  it('false when locked / none even with a matching-looking address', () => {
    expect(nodeProvesCanSign({ state: 'locked', address: 'xch1self' }, SEED)).toBe(false);
    expect(nodeProvesCanSign({ state: 'none', address: null }, SEED)).toBe(false);
  });
  it('false on an address mismatch (a DIFFERENT key was loaded)', () => {
    expect(nodeProvesCanSign({ state: 'unlocked', address: 'xch1OTHER' }, SEED)).toBe(false);
    expect(nodeProvesCanSign({ state: 'unlocked', address: null }, SEED)).toBe(false);
  });
});

describe('cutoverEligibility (multi-wallet flip gate)', () => {
  it('eligible with 0 or 1 custody wallet', () => {
    expect(cutoverEligibility([])).toEqual({ eligible: true, custodyWalletCount: 0 });
    expect(cutoverEligibility([entry('A')])).toEqual({ eligible: true, custodyWalletCount: 1 });
  });
  it('REFUSES >1 custody wallet (node custody is single-wallet, #370 follow-up)', () => {
    expect(cutoverEligibility([entry('A'), entry('B'), entry('C')])).toEqual({
      eligible: false,
      custodyWalletCount: 3,
      reason: 'multi-wallet-needs-node-custody',
    });
  });
  it('watch-only entries (no record) do not count toward the limit', () => {
    const watch = { id: 'W', label: 'W', createdAt: 0, activeIndex: 0, kind: 'watch' as const };
    expect(cutoverEligibility([entry('A'), watch])).toMatchObject({ eligible: true, custodyWalletCount: 1 });
  });
});

describe('runSeedMigration — happy path', () => {
  it('imports, verifies, THEN purges ONLY the migrated wallet id (order matters); returns migrated', async () => {
    const node = fakeNode({ state: 'none', address: null });
    const order: string[] = [];
    const purgeWallet = vi.fn(async (id: string) => {
      order.push(`purge:${id}`);
    });
    const nodeImport = vi.fn(async (m: string, p: string) => {
      order.push('import');
      return node.nodeImport(m, p);
    });
    const d = deps({ getLocalSeed: async () => SEED, ...node, nodeImport, purgeWallet });

    const outcome = await runSeedMigration('pw', d);

    expect(outcome).toBe('migrated');
    expect(nodeImport).toHaveBeenCalledWith(SEED.mnemonic, 'pw');
    expect(purgeWallet).toHaveBeenCalledWith('A');
    expect(order).toEqual(['import', 'purge:A']); // NEVER purge before import+verify
  });
});

describe('runSeedMigration — CRITICAL: multi-wallet purge is SCOPED (fund-loss regression)', () => {
  it('registry {A active, B, C} → migrate+verify A → ONLY A removed; B and C untouched', async () => {
    // The purge dep is wired to the REAL scoped purge against a {A,B,C} registry, so this is an
    // end-to-end regression: the whole registry must NEVER be nuked when only A was migrated.
    let registry: WalletEntry[] = [entry('A'), entry('B'), entry('C')];
    const node = fakeNode({ state: 'none', address: null });
    const purgeWallet = vi.fn(async (id: string) => {
      const res = purgeWalletFromRegistry(registry, 'A', id);
      registry = res.remaining;
      expect(res.fullTeardown).toBe(false); // B + C remain → no wholesale teardown
    });
    const d = deps({ ...node, purgeWallet });

    await runSeedMigration('pw', d);

    expect(registry.map((w) => w.id).sort()).toEqual(['B', 'C']); // A gone, B + C intact
    expect(registry.every((w) => !!w.record)).toBe(true); // their encrypted seeds survive
  });

  it('single-wallet registry {A} → migrate A → full teardown (nothing remains)', async () => {
    let registry: WalletEntry[] = [entry('A')];
    let teardown = false;
    const node = fakeNode({ state: 'none', address: null });
    const purgeWallet = vi.fn(async (id: string) => {
      const res = purgeWalletFromRegistry(registry, 'A', id);
      registry = res.remaining;
      teardown = res.fullTeardown;
    });
    await runSeedMigration('pw', deps({ ...node, purgeWallet }));
    expect(registry).toEqual([]);
    expect(teardown).toBe(true);
  });
});

describe('runSeedMigration — SAFETY: the gate blocks the purge', () => {
  it('address MISMATCH after import → abort, NOTHING purged', async () => {
    const node = fakeNode({ state: 'none', address: null }, { importAddress: 'xch1WRONG' });
    const purgeWallet = vi.fn(async () => {});
    await expect(runSeedMigration('pw', deps({ ...node, purgeWallet }))).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('node still not unlocked after import → abort, NOTHING purged', async () => {
    const nodeStatus = vi.fn(async (): Promise<NodeCustodyStatus> => ({ state: 'none', address: null }));
    const nodeImport = vi.fn(async () => ({ address: SEED.expectedAddress }));
    const purgeWallet = vi.fn(async () => {});
    await expect(runSeedMigration('pw', deps({ nodeStatus, nodeImport, purgeWallet }))).rejects.toBeInstanceOf(
      MigrationAbortedError,
    );
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('import throws → abort (import-failed), NOTHING purged', async () => {
    const purgeWallet = vi.fn(async () => {});
    const d = deps({
      nodeStatus: async () => ({ state: 'none', address: null }),
      nodeImport: async () => {
        throw new Error('boom');
      },
      purgeWallet,
    });
    await expect(runSeedMigration('pw', d)).rejects.toMatchObject({ reason: 'import-failed' });
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('wrong local password → abort (seed-unavailable), no import, no purge', async () => {
    const nodeImport = vi.fn();
    const purgeWallet = vi.fn(async () => {});
    const d = deps({
      getLocalSeed: async () => {
        throw new Error('bad password');
      },
      nodeImport,
      purgeWallet,
    });
    await expect(runSeedMigration('pw', d)).rejects.toMatchObject({ reason: 'seed-unavailable' });
    expect(nodeImport).not.toHaveBeenCalled();
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('node unreachable → abort (node-unreachable), no purge', async () => {
    const purgeWallet = vi.fn(async () => {});
    const d = deps({
      nodeStatus: async () => {
        throw new Error('ECONNREFUSED');
      },
      purgeWallet,
    });
    await expect(runSeedMigration('pw', d)).rejects.toMatchObject({ reason: 'node-unreachable' });
    expect(purgeWallet).not.toHaveBeenCalled();
  });
});

describe('runSeedMigration — the !local branch NEVER purges (no verify is possible)', () => {
  it('no local seed + node holds a wallet (locked) → already-on-node, NO purge', async () => {
    const purgeWallet = vi.fn(async () => {});
    const d = deps({
      getLocalSeed: async () => null,
      nodeStatus: async () => ({ state: 'locked', address: null }),
      purgeWallet,
    });
    expect(await runSeedMigration('pw', d)).toBe('already-on-node');
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('no local seed + node holds a wallet (unlocked, unrelated address) → already-on-node, NO purge', async () => {
    const purgeWallet = vi.fn(async () => {});
    const d = deps({
      getLocalSeed: async () => null,
      nodeStatus: async () => ({ state: 'unlocked', address: 'xch1UNRELATED' }),
      purgeWallet,
    });
    expect(await runSeedMigration('pw', d)).toBe('already-on-node');
    expect(purgeWallet).not.toHaveBeenCalled();
  });

  it('no local seed + node none → nothing-to-migrate, NO purge', async () => {
    const purgeWallet = vi.fn(async () => {});
    const d = deps({ getLocalSeed: async () => null, nodeStatus: async () => ({ state: 'none', address: null }), purgeWallet });
    expect(await runSeedMigration('pw', d)).toBe('nothing-to-migrate');
    expect(purgeWallet).not.toHaveBeenCalled();
  });
});

describe('runSeedMigration — idempotency', () => {
  it('node already holds the seed (unlocked, matching) + local still present → verify, purge A, NO re-import', async () => {
    const node = fakeNode({ state: 'unlocked', address: SEED.expectedAddress });
    const purgeWallet = vi.fn(async () => {});
    const outcome = await runSeedMigration('pw', deps({ ...node, purgeWallet }));
    expect(outcome).toBe('already-on-node');
    expect(node.nodeImport).not.toHaveBeenCalled();
    expect(purgeWallet).toHaveBeenCalledWith('A');
  });
});

describe('runSeedMigration — resumability (crash mid-migration)', () => {
  it('crash AFTER import, BEFORE purge → re-run unlocks/verifies + purges A, never re-imports', async () => {
    const node = fakeNode({ state: 'locked', address: null });
    const purgeWallet = vi.fn(async () => {});
    const outcome = await runSeedMigration('pw', deps({ ...node, purgeWallet }));
    expect(outcome).toBe('already-on-node');
    expect(node.nodeImport).not.toHaveBeenCalled();
    expect(node.nodeUnlock).toHaveBeenCalledWith('pw');
    expect(purgeWallet).toHaveBeenCalledWith('A');
  });

  it('crash-resume where unlock reveals a MISMATCHED key → abort, NOTHING purged', async () => {
    const node = fakeNode({ state: 'locked', address: null }, { unlockAddress: 'xch1WRONG' });
    const purgeWallet = vi.fn(async () => {});
    await expect(runSeedMigration('pw', deps({ ...node, purgeWallet }))).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(purgeWallet).not.toHaveBeenCalled();
  });
});
