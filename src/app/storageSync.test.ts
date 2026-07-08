import { describe, it, expect } from 'vitest';
import { createStore } from '@/app/store';
import { installStorageSync } from '@/app/storageSync';

/** Fire the setup stub's onChanged listeners. */
function emitChange(changes: Record<string, { newValue?: unknown }>, area = 'local') {
  (chrome.storage.onChanged as unknown as { _emit: (...a: unknown[]) => void })._emit(changes, area);
}

describe('installStorageSync', () => {
  it('hydrates settings on install and follows later changes', async () => {
    await chrome.storage.local.set({ 'wallet.settings': { locale: 'fr', advanced: true } });
    const store = createStore();
    const cleanup = await installStorageSync(store);
    expect(store.getState().ui.locale).toBe('fr');

    emitChange({ 'wallet.settings': { newValue: { locale: 'de' } } });
    expect(store.getState().ui.locale).toBe('de');
    cleanup();
  });

  it('hydrates theme + network (#111, #108) and follows later changes', async () => {
    await chrome.storage.local.set({ 'wallet.settings': { theme: 'dark', network: 'testnet' } });
    const store = createStore();
    const cleanup = await installStorageSync(store);
    expect(store.getState().ui.theme).toBe('dark');
    expect(store.getState().ui.network).toBe('testnet');

    emitChange({ 'wallet.settings': { newValue: { theme: 'light', network: 'mainnet' } } });
    expect(store.getState().ui.theme).toBe('light');
    expect(store.getState().ui.network).toBe('mainnet');
    cleanup();
  });

  it('ignores non-local/session areas and unrelated keys without throwing', async () => {
    const store = createStore();
    const cleanup = await installStorageSync(store);
    expect(() => {
      emitChange({ 'wallet.connection': { newValue: { connected: true } } });
      emitChange({ 'walletCache.epoch.Balances': { newValue: 3 } });
      emitChange({ other: { newValue: 1 } }, 'sync');
    }).not.toThrow();
    cleanup();
  });
});
