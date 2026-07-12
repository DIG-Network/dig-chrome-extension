import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '@/app/store';
import { tippingApi } from '@/features/tipping/tippingApi';

/**
 * The tipping endpoints route over the SW `tipRpc` seam (SPEC §18.23). We mock
 * `chrome.runtime.sendMessage` keyed on `message.method` and assert: the right method+params are
 * sent, the raw node payloads are normalized (config/ledger), and a `{success:false}` reply
 * surfaces as an RTK Query error.
 */
function mockSw(router: (msg: { action: string; method?: string; params?: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; method?: string; params?: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('tippingApi endpoints', () => {
  it('getTipConfig sends tip.get_config and normalizes the node config', async () => {
    const sw = mockSw((m) =>
      m.method === 'tip.get_config'
        ? { creator: { enabled: true, dig_amount: 1000, mode: 'daily-budget' }, daily_total_cap: 5000, fee: 10 }
        : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(tippingApi.endpoints.getTipConfig.initiate());
    expect(res.data?.creator.enabled).toBe(true);
    expect(res.data?.creator.dig_amount).toBe(1000);
    expect(res.data?.creator.mode).toBe('daily-budget');
    expect(res.data?.dev.enabled).toBe(false); // absent side filled safely
    expect(res.data?.daily_total_cap).toBe(5000);
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tipRpc', method: 'tip.get_config' }),
      expect.any(Function),
    );
  });

  it('getTipLedger accepts a bare array and normalizes/filters it', async () => {
    mockSw((m) =>
      m.method === 'tip.get_ledger'
        ? [
            { id: 'a', recipient_ph: 'ph', dig_amount: 1000, ts: 1700000000, trigger: 'auto', kind: 'creator', status: 'confirmed' },
            { id: '', dig_amount: 5 }, // dropped
          ]
        : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(tippingApi.endpoints.getTipLedger.initiate());
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0].id).toBe('a');
  });

  it('getTipLedger unwraps an { entries } envelope and forwards since_ts', async () => {
    const sw = mockSw((m) =>
      m.method === 'tip.get_ledger'
        ? { entries: [{ id: 'x', recipient_ph: 'p', dig_amount: 250, ts: 1, trigger: 'manual', kind: 'dev', status: 'pending' }] }
        : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(tippingApi.endpoints.getTipLedger.initiate({ sinceTs: 42 }));
    expect(res.data?.[0].id).toBe('x');
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tipRpc', method: 'tip.get_ledger', params: { since_ts: 42 } }),
      expect.any(Function),
    );
  });

  it('setTipConfig sends the config as params and returns the normalized stored config', async () => {
    const cfg = {
      creator: { enabled: true, dig_amount: 2000, mode: 'per-site-per-day' as const, per_site_cap: 5000, per_site_overrides: {} },
      dev: { enabled: true, dig_amount: 500, mode: 'per-site-per-day' as const, per_site_cap: 0, per_site_overrides: {} },
      daily_total_cap: 10000,
      fee: 0,
    };
    const sw = mockSw((m) => (m.method === 'tip.set_config' ? m.params : { success: false }));
    const store = createStore();
    const res = await store.dispatch(tippingApi.endpoints.setTipConfig.initiate(cfg));
    expect(res.data?.creator.dig_amount).toBe(2000);
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tipRpc', method: 'tip.set_config', params: cfg }),
      expect.any(Function),
    );
  });

  it('manualTip sends tip.manual with store_id and returns the outcome; invalidates on skip', async () => {
    const sw = mockSw((m) =>
      m.method === 'tip.manual' ? { result: 'skipped', reason: 'wallet-unavailable: not synced' } : { success: false },
    );
    const store = createStore();
    const res = await store.dispatch(tippingApi.endpoints.manualTip.initiate({ storeId: 'store1' }));
    expect(res.data?.result).toBe('skipped');
    expect(res.data?.reason).toContain('wallet-unavailable');
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tipRpc', method: 'tip.manual', params: { store_id: 'store1' } }),
      expect.any(Function),
    );
  });

  it('surfaces a not-paired (-32030) mutation failure as an RTK Query error', async () => {
    mockSw((m) =>
      m.method === 'tip.set_config' ? { success: false, code: -32030, error: 'not paired', message: 'not paired' } : {},
    );
    const store = createStore();
    const res = await store.dispatch(
      tippingApi.endpoints.setTipConfig.initiate({
        creator: { enabled: true, dig_amount: 1, mode: 'per-site-per-day', per_site_cap: 0, per_site_overrides: {} },
        dev: { enabled: false, dig_amount: 0, mode: 'per-site-per-day', per_site_cap: 0, per_site_overrides: {} },
        daily_total_cap: 0,
        fee: 0,
      }),
    );
    expect(res.error).toBeDefined();
    expect((res.error as { code?: number }).code).toBe(-32030);
  });
});
