import { describe, it, expect } from 'vitest';
import {
  CHAIN_SOURCE_MODES,
  DEFAULT_CHAIN_SOURCE_MODE,
  isChainSourceMode,
  readChainSourceSetting,
  normalizeCustomNodeUrl,
  resolveWalletSource,
  verifyNodeTracksConnectedWallet,
  type ResolveWalletSourceDeps,
} from '@/lib/wallet-source';

/**
 * A `ResolveWalletSourceDeps` whose probes are scripted per-call, recording what was asked.
 * `tracks` scripts the verified-tracking gate (#399/#407) and defaults to `true` here — most cases
 * exercise the "node tracks the connected wallet" branch; pass `tracks: false` for the not-tracking
 * (self-custody fallback) cases. This test convenience is DISTINCT from the SHIPPED production
 * default `verifyNodeTracksConnectedWallet`, which is `false` (see its own describe block below).
 */
function deps(
  overrides: Partial<ResolveWalletSourceDeps> & {
    ladder?: string | null;
    probe?: (base: string) => string | null;
    tracks?: boolean;
  } = {},
): { deps: ResolveWalletSourceDeps; calls: { ladder: number; probed: string[]; verified: string[] } } {
  const calls = { ladder: 0, probed: [] as string[], verified: [] as string[] };
  return {
    calls,
    deps: {
      resolveLadderNode:
        overrides.resolveLadderNode ??
        (async () => {
          calls.ladder += 1;
          return overrides.ladder ?? null;
        }),
      probeNode:
        overrides.probeNode ??
        (async (base: string) => {
          calls.probed.push(base);
          return overrides.probe ? overrides.probe(base) : null;
        }),
      verifyNodeTracksWallet:
        overrides.verifyNodeTracksWallet ??
        (async (base: string) => {
          calls.verified.push(base);
          return overrides.tracks ?? true;
        }),
    },
  };
}

describe('chain-source mode constants', () => {
  it('lists the wallet-backend modes with auto as the default (incl. Sage RPC, #394)', () => {
    expect(CHAIN_SOURCE_MODES).toEqual(['auto', 'node', 'coinset', 'custom', 'sage']);
    expect(DEFAULT_CHAIN_SOURCE_MODE).toBe('auto');
  });

  it('validates modes', () => {
    for (const m of CHAIN_SOURCE_MODES) expect(isChainSourceMode(m)).toBe(true);
    expect(isChainSourceMode('nope')).toBe(false);
    expect(isChainSourceMode(undefined)).toBe(false);
    expect(isChainSourceMode(null)).toBe(false);
  });
});

describe('readChainSourceSetting', () => {
  it('defaults to auto with no custom url when unset', () => {
    expect(readChainSourceSetting(undefined)).toEqual({ mode: 'auto', customUrl: '', sageUrl: '' });
    expect(readChainSourceSetting({})).toEqual({ mode: 'auto', customUrl: '', sageUrl: '' });
  });

  it('reads a persisted mode + custom url', () => {
    expect(readChainSourceSetting({ chainSourceMode: 'node' })).toEqual({ mode: 'node', customUrl: '', sageUrl: '' });
    expect(readChainSourceSetting({ chainSourceMode: 'custom', chainSourceUrl: 'http://my-node:9778' })).toEqual({
      mode: 'custom',
      customUrl: 'http://my-node:9778',
      sageUrl: '',
    });
  });

  it('reads a persisted Sage endpoint (#394)', () => {
    expect(readChainSourceSetting({ chainSourceMode: 'sage', sageUrl: 'http://localhost:9257' })).toEqual({
      mode: 'sage',
      customUrl: '',
      sageUrl: 'http://localhost:9257',
    });
  });

  it('falls back to auto for an unrecognized mode', () => {
    expect(readChainSourceSetting({ chainSourceMode: 'bogus' }).mode).toBe('auto');
  });
});

describe('normalizeCustomNodeUrl', () => {
  it('prepends http:// when no scheme and strips a trailing slash', () => {
    expect(normalizeCustomNodeUrl('my-node:9778')).toBe('http://my-node:9778');
    expect(normalizeCustomNodeUrl('http://my-node:9778/')).toBe('http://my-node:9778');
    expect(normalizeCustomNodeUrl('https://node.example')).toBe('https://node.example');
  });

  it('returns empty for blank input', () => {
    expect(normalizeCustomNodeUrl('')).toBe('');
    expect(normalizeCustomNodeUrl('   ')).toBe('');
    expect(normalizeCustomNodeUrl(undefined)).toBe('');
  });
});

describe('resolveWalletSource — coinset mode', () => {
  it('forces coinset, never probing a node', async () => {
    const { deps: d, calls } = deps({ ladder: 'http://localhost:9778' });
    expect(await resolveWalletSource({ mode: 'coinset' }, d)).toEqual({ kind: 'coinset' });
    expect(calls.ladder).toBe(0);
    expect(calls.probed).toEqual([]);
  });
});

describe('resolveWalletSource — auto mode (node-first, coinset fallback)', () => {
  it('uses the ladder node when reachable (non-strict → may fall back on read error)', async () => {
    const { deps: d } = deps({ ladder: 'http://dig.local' });
    expect(await resolveWalletSource({ mode: 'auto' }, d)).toEqual({
      kind: 'node',
      base: 'http://dig.local',
      strict: false,
    });
  });

  it('falls through to coinset when NO node is reachable', async () => {
    const { deps: d, calls } = deps({ ladder: null });
    expect(await resolveWalletSource({ mode: 'auto' }, d)).toEqual({ kind: 'coinset' });
    expect(calls.ladder).toBe(1);
  });
});

describe('resolveWalletSource — node-only mode (strict)', () => {
  it('forces the ladder node, strict (no coinset fallback on error)', async () => {
    const { deps: d } = deps({ ladder: 'http://localhost:9778' });
    expect(await resolveWalletSource({ mode: 'node' }, d)).toEqual({
      kind: 'node',
      base: 'http://localhost:9778',
      strict: true,
    });
  });

  it('is unavailable (surfaced as error) when the node is unreachable — never silently coinset', async () => {
    const { deps: d } = deps({ ladder: null });
    expect(await resolveWalletSource({ mode: 'node' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'node-unreachable',
    });
  });
});

describe('resolveWalletSource — custom mode (explicit URL overrides the ladder)', () => {
  it('probes the custom url and uses it (strict), never the ladder', async () => {
    const { deps: d, calls } = deps({ probe: (b) => (b === 'http://my-node:9778' ? b : null) });
    expect(await resolveWalletSource({ mode: 'custom', customUrl: 'my-node:9778' }, d)).toEqual({
      kind: 'node',
      base: 'http://my-node:9778',
      strict: true,
    });
    expect(calls.ladder).toBe(0);
    expect(calls.probed).toEqual(['http://my-node:9778']);
  });

  it('is unavailable when the custom url is missing', async () => {
    const { deps: d, calls } = deps({});
    expect(await resolveWalletSource({ mode: 'custom', customUrl: '' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'custom-missing',
    });
    expect(calls.probed).toEqual([]);
  });

  it('is unavailable when the custom url is unreachable — never silently coinset', async () => {
    const { deps: d } = deps({ probe: () => null });
    expect(await resolveWalletSource({ mode: 'custom', customUrl: 'http://down:9778' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'custom-unreachable',
    });
  });
});

describe('resolveWalletSource — Sage RPC mode (#394)', () => {
  it('probes the Sage endpoint and uses it (strict), WITHOUT the node-tracking gate (user owns Sage)', async () => {
    const { deps: d, calls } = deps({ probe: (b) => (b === 'http://localhost:9257' ? b : null) });
    expect(await resolveWalletSource({ mode: 'sage', sageUrl: 'localhost:9257' }, d)).toEqual({
      kind: 'node',
      base: 'http://localhost:9257',
      strict: true,
    });
    // Sage is the user's OWN wallet → trusted; the #399/#407 tracking gate is NOT consulted.
    expect(calls.verified).toEqual([]);
    expect(calls.ladder).toBe(0);
    expect(calls.probed).toEqual(['http://localhost:9257']);
  });

  it('is unavailable (sage-missing) when no Sage endpoint is configured', async () => {
    const { deps: d, calls } = deps({});
    expect(await resolveWalletSource({ mode: 'sage', sageUrl: '' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'sage-missing',
    });
    expect(calls.probed).toEqual([]);
  });

  it('is unavailable (sage-unreachable) when the Sage endpoint does not answer — never silently coinset', async () => {
    const { deps: d } = deps({ probe: () => null });
    expect(await resolveWalletSource({ mode: 'sage', sageUrl: 'http://localhost:9257' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'sage-unreachable',
    });
  });
});

describe('resolveWalletSource — verified-tracking gate (#399/#407)', () => {
  // #399 root cause: a reachable dig-node answered wallet reads from its OWN identity-less/unsynced
  // wallet (0 XCH / [] CATs), so both balances read 0 by construction. Node-sourced wallet data is
  // now used ONLY when the node is VERIFIED to track the connected wallet's identity.

  it('auto: a reachable node that does NOT track the connected wallet falls through to coinset (never its 0/0)', async () => {
    const { deps: d, calls } = deps({ ladder: 'http://localhost:9778', tracks: false });
    expect(await resolveWalletSource({ mode: 'auto' }, d)).toEqual({ kind: 'coinset' });
    expect(calls.verified).toEqual(['http://localhost:9778']);
  });

  it('auto: a reachable node that DOES track the wallet is used (non-strict)', async () => {
    const { deps: d } = deps({ ladder: 'http://dig.local', tracks: true });
    expect(await resolveWalletSource({ mode: 'auto' }, d)).toEqual({
      kind: 'node',
      base: 'http://dig.local',
      strict: false,
    });
  });

  it('auto: never verifies (or uses) a node when none is reachable', async () => {
    const { deps: d, calls } = deps({ ladder: null });
    expect(await resolveWalletSource({ mode: 'auto' }, d)).toEqual({ kind: 'coinset' });
    expect(calls.verified).toEqual([]);
  });

  it('node (strict): a reachable-but-not-tracking node surfaces node-not-tracking, never a silent 0', async () => {
    const { deps: d } = deps({ ladder: 'http://localhost:9778', tracks: false });
    expect(await resolveWalletSource({ mode: 'node' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'node-not-tracking',
    });
  });

  it('custom (strict): a reachable-but-not-tracking node surfaces node-not-tracking', async () => {
    const { deps: d } = deps({ probe: (b) => b, tracks: false });
    expect(await resolveWalletSource({ mode: 'custom', customUrl: 'http://my-node:9778' }, d)).toEqual({
      kind: 'unavailable',
      reason: 'node-not-tracking',
    });
  });
});

describe('verifyNodeTracksConnectedWallet — shipped P0 default (self-custody until #407 handshake)', () => {
  it('reports NO node as verified-tracking, so connected-wallet reads use the self-custody scan', async () => {
    expect(await verifyNodeTracksConnectedWallet('http://localhost:9778')).toBe(false);
    expect(await verifyNodeTracksConnectedWallet('http://dig.local')).toBe(false);
  });

  it('#399 regression: auto mode with the SHIPPED verifier + a reachable node resolves to coinset (self-custody), NEVER the node 0/0', async () => {
    const source = await resolveWalletSource(
      { mode: 'auto' },
      {
        resolveLadderNode: async () => 'http://localhost:9778',
        probeNode: async (b) => b,
        verifyNodeTracksWallet: verifyNodeTracksConnectedWallet,
      },
    );
    expect(source).toEqual({ kind: 'coinset' });
  });
});
