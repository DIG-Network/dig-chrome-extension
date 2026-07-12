import { describe, it, expect } from 'vitest';
import { walletSyncView } from '@/features/wallet/walletSyncView';
import type { WalletSyncStatus } from '@/lib/dig-node-wallet-ws';

const at = (s: Partial<WalletSyncStatus>): WalletSyncStatus => ({
  state: 'synced',
  peakHeight: null,
  targetHeight: null,
  updatedAt: 0,
  ...s,
});

describe('walletSyncView (#373)', () => {
  it('synced → good tone, no banner, balances trusted', () => {
    const v = walletSyncView(at({ state: 'synced', peakHeight: 100, targetHeight: 100 }));
    expect(v.tone).toBe('good');
    expect(v.showBanner).toBe(false);
    expect(v.balancesUntrusted).toBe(false);
    expect(v.role).toBe('status');
    expect(v.percent).toBe(100);
  });

  it('syncing with both heights → warn tone, prominent banner, computed percent, untrusted balances', () => {
    const v = walletSyncView(at({ state: 'syncing', peakHeight: 50, targetHeight: 200 }));
    expect(v.tone).toBe('warn');
    expect(v.showBanner).toBe(true);
    expect(v.balancesUntrusted).toBe(true);
    expect(v.percent).toBe(25);
    expect(v.detailId).toBe('wallet.sync.syncing.detail');
    expect(v.values).toEqual({ peak: '50', target: '200' });
    expect(v.role).toBe('status');
  });

  it('syncing with an unknown target → indeterminate detail + null percent', () => {
    const v = walletSyncView(at({ state: 'syncing', peakHeight: 50, targetHeight: null }));
    expect(v.percent).toBeNull();
    expect(v.detailId).toBe('wallet.sync.syncing.detail.indeterminate');
    expect(v.values).toEqual({ peak: '50', target: '?' });
  });

  it('clamps a percentage above 100 (peak briefly beyond target) to 100', () => {
    const v = walletSyncView(at({ state: 'syncing', peakHeight: 210, targetHeight: 200 }));
    expect(v.percent).toBe(100);
  });

  it('guards a zero target (no divide-by-zero) → null percent', () => {
    const v = walletSyncView(at({ state: 'syncing', peakHeight: 5, targetHeight: 0 }));
    expect(v.percent).toBeNull();
  });

  it('disconnected → bad tone, alert role, prominent banner, untrusted balances', () => {
    const v = walletSyncView(at({ state: 'disconnected' }));
    expect(v.tone).toBe('bad');
    expect(v.role).toBe('alert');
    expect(v.showBanner).toBe(true);
    expect(v.balancesUntrusted).toBe(true);
    expect(v.labelId).toBe('wallet.sync.disconnected');
  });

  it('defaults null/undefined status to a disconnected view (never a stale synced)', () => {
    expect(walletSyncView(null).state).toBe('disconnected');
    expect(walletSyncView(undefined).showBanner).toBe(true);
  });
});
