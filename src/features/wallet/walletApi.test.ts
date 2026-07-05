import { describe, it, expect, vi } from 'vitest';
import { createStore } from '@/app/store';
import { walletApi } from '@/features/wallet/walletApi';
import { makeTransport, connectedTransport } from '@/test/harness';

describe('walletApi endpoints', () => {
  it('getConnection returns the transport connection', async () => {
    const store = createStore(connectedTransport('xch1abc'));
    const res = await store.dispatch(walletApi.endpoints.getConnection.initiate());
    expect(res.data).toMatchObject({ connected: true, address: 'xch1abc' });
  });

  it('getBalances returns [] when not connected', async () => {
    const store = createStore(makeTransport());
    const res = await store.dispatch(walletApi.endpoints.getBalances.initiate());
    expect(res.data).toEqual([]);
  });

  it('getBalances aggregates per-asset balances when connected', async () => {
    await chrome.storage.local.set({ 'wallet.watchedCats': [] });
    const request = vi.fn(async () => ({ confirmed: 2_510_000_000_000 }));
    const store = createStore(makeTransport({ isConnected: vi.fn(async () => true), request }));
    const res = await store.dispatch(walletApi.endpoints.getBalances.initiate());
    expect(res.data?.length).toBeGreaterThanOrEqual(2); // XCH + $DIG
    expect(res.data?.[0].descriptor.key).toBe('xch');
    expect(res.data?.[0].balance).toBe(2_510_000_000_000);
  });

  it('getActivity formats transactions via the shared view-model', async () => {
    const request = vi.fn(async () => ({ transactions: [{ amount: 5, type: 'incoming', confirmed: true, name: 'abc' }] }));
    const store = createStore(makeTransport({ isConnected: vi.fn(async () => true), request }));
    const res = await store.dispatch(walletApi.endpoints.getActivity.initiate());
    expect(res.data?.[0]).toMatchObject({ direction: 'in', confirmed: true });
  });

  it('sendAsset brokers a chia_send request', async () => {
    const request = vi.fn(async () => ({ success: true }));
    const store = createStore(makeTransport({ request }));
    await store.dispatch(walletApi.endpoints.sendAsset.initiate({ method: 'chia_send', params: { amount: 1 } }));
    expect(request).toHaveBeenCalledWith('chia_send', { amount: 1 });
  });

  it('disconnect calls the transport', async () => {
    const disconnect = vi.fn(async () => {});
    const store = createStore(makeTransport({ disconnect }));
    await store.dispatch(walletApi.endpoints.disconnect.initiate());
    expect(disconnect).toHaveBeenCalled();
  });
});
