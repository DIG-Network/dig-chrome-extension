import { describe, it, expect } from 'vitest';
import {
  CHAIN_SOURCE_MODES,
  DEFAULT_CHAIN_SOURCE_MODE,
  isChainSourceMode,
  readChainSourceSetting,
  normalizeCustomNodeUrl,
  resolveWalletSource,
  type ResolveWalletSourceDeps,
} from '@/lib/wallet-source';

/** A `ResolveWalletSourceDeps` whose probes are scripted per-call, recording what was asked. */
function deps(
  overrides: Partial<ResolveWalletSourceDeps> & { ladder?: string | null; probe?: (base: string) => string | null } = {},
): { deps: ResolveWalletSourceDeps; calls: { ladder: number; probed: string[] } } {
  const calls = { ladder: 0, probed: [] as string[] };
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
    },
  };
}

describe('chain-source mode constants', () => {
  it('lists the four states with auto as the default', () => {
    expect(CHAIN_SOURCE_MODES).toEqual(['auto', 'node', 'coinset', 'custom']);
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
    expect(readChainSourceSetting(undefined)).toEqual({ mode: 'auto', customUrl: '' });
    expect(readChainSourceSetting({})).toEqual({ mode: 'auto', customUrl: '' });
  });

  it('reads a persisted mode + custom url', () => {
    expect(readChainSourceSetting({ chainSourceMode: 'node' })).toEqual({ mode: 'node', customUrl: '' });
    expect(readChainSourceSetting({ chainSourceMode: 'custom', chainSourceUrl: 'http://my-node:9778' })).toEqual({
      mode: 'custom',
      customUrl: 'http://my-node:9778',
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
