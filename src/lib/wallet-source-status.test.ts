import { describe, it, expect } from 'vitest';
import { walletSourceIndicatorView } from '@/lib/wallet-source-status';
import type { ResolvedWalletSource } from '@/lib/wallet-source';

/**
 * Tests for the wallet-data source indicator view-model (#222) — the PURE mapping from the
 * resolved §5.3 wallet-data source + the selected mode to the "Local dig-node detected" indicator
 * `ChainSourceSetting` renders. Mirrors `resolve-status.test.ts` / `dig-dns-status.test.ts`'s split:
 * chrome-free, no sockets, fully deterministic.
 */

const NODE: ResolvedWalletSource = { kind: 'node', base: 'http://localhost:9778', strict: false };
const COINSET: ResolvedWalletSource = { kind: 'coinset' };
const UNAVAILABLE: ResolvedWalletSource = { kind: 'unavailable', reason: 'node-unreachable' };

describe('walletSourceIndicatorView', () => {
  it('is visible with a good tone + the resolved endpoint when Auto mode auto-selected a node', () => {
    const view = walletSourceIndicatorView('auto', NODE);
    expect(view.visible).toBe(true);
    expect(view.tone).toBe('good');
    expect(view.labelId).toBe('custody.source.detected');
    expect(view.endpoint).toBe('http://localhost:9778');
  });

  it('is hidden in Auto mode when the ladder resolved to coinset (no local node reachable)', () => {
    const view = walletSourceIndicatorView('auto', COINSET);
    expect(view.visible).toBe(false);
  });

  it('is hidden when the mode is forced to "node" — the mode-specific hint already covers it', () => {
    const view = walletSourceIndicatorView('node', NODE);
    expect(view.visible).toBe(false);
  });

  it('is hidden when the mode is "custom" — an explicit override, not a zero-config detection', () => {
    const view = walletSourceIndicatorView('custom', NODE);
    expect(view.visible).toBe(false);
  });

  it('is hidden when the mode is forced to "coinset"', () => {
    const view = walletSourceIndicatorView('coinset', COINSET);
    expect(view.visible).toBe(false);
  });

  it('is hidden for an unavailable resolution even in Auto mode', () => {
    const view = walletSourceIndicatorView('auto', UNAVAILABLE);
    expect(view.visible).toBe(false);
  });

  it('is hidden when the resolution has not loaded yet (undefined/null)', () => {
    expect(walletSourceIndicatorView('auto', undefined).visible).toBe(false);
    expect(walletSourceIndicatorView('auto', null).visible).toBe(false);
  });
});
