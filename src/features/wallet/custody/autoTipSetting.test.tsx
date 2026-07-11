import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { AutoTipSetting } from '@/features/wallet/custody/AutoTipSetting';
import { AUTOTIP_CONFIG_KEY, type AutoTipConfig } from '@/lib/autoTip';

function mockStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return store;
}

const cfg = (store: Record<string, unknown>) => store[AUTOTIP_CONFIG_KEY] as AutoTipConfig | undefined;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => mockStorage());

describe('AutoTipSetting (#379)', () => {
  it('defaults to OFF (opt-in) — the toggle is unchecked', async () => {
    mockStorage();
    renderWithProviders(<AutoTipSetting />);
    const toggle = await screen.findByTestId('auto-tip-toggle');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('persists the enable toggle', async () => {
    const store = mockStorage();
    renderWithProviders(<AutoTipSetting />);
    fireEvent.click(await screen.findByTestId('auto-tip-toggle'));
    await waitFor(() => expect(cfg(store)?.enabled).toBe(true));
  });

  it('persists the tip amount and flags an invalid (zero/empty) amount', async () => {
    const store = mockStorage();
    renderWithProviders(<AutoTipSetting />);
    const amount = await screen.findByTestId('auto-tip-amount');
    fireEvent.change(amount, { target: { value: '2.5' } });
    await waitFor(() => expect(cfg(store)?.amountDig).toBe('2.5'));
    expect(screen.queryByTestId('auto-tip-amount-error')).toBeNull();

    fireEvent.change(amount, { target: { value: '0' } });
    expect(await screen.findByTestId('auto-tip-amount-error')).toBeInTheDocument();
  });

  it('persists the frequency mode via the segmented control', async () => {
    const store = mockStorage();
    renderWithProviders(<AutoTipSetting />);
    fireEvent.click(await screen.findByTestId('seg-per-day-period'));
    await waitFor(() => expect(cfg(store)?.mode).toBe('per-day-period'));
  });
});
