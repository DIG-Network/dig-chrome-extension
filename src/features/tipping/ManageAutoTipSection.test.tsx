import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ManageAutoTipSection } from '@/features/tipping/ManageAutoTipSection';

const CONFIG = {
  creator: { enabled: true, dig_amount: 1000, mode: 'per-site-per-day', per_site_cap: 5000, per_site_overrides: {} },
  dev: { enabled: false, dig_amount: 250, mode: 'per-site-per-day', per_site_cap: 0, per_site_overrides: {} },
  daily_total_cap: 10000,
  fee: 0,
};

/** Route the SW seam: pairing phase + tip.get_config/tip.set_config. `setSpy` captures set params. */
function mockSw({ phase = 'paired', setSpy }: { phase?: string; setSpy?: (params: unknown) => void } = {}) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string; method?: string; params?: unknown } | undefined, cb?: (r: unknown) => void) => {
      let reply: unknown = { success: false };
      if (msg?.action === 'pairingState') reply = { phase };
      else if (msg?.method === 'tip.get_config') reply = CONFIG;
      else if (msg?.method === 'tip.set_config') {
        setSpy?.(msg.params);
        reply = msg.params;
      }
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('ManageAutoTipSection', () => {
  it('shows the honest disclosure and node-down note when offline', () => {
    mockSw();
    renderWithProviders(<ManageAutoTipSection nodeOnline={false} />);
    expect(screen.getByTestId('tip-manage-disclosure')).toBeTruthy();
    expect(screen.getByTestId('tip-manage-nodedown')).toBeTruthy();
  });

  it('renders the editable form (both policies) when paired + config loaded', async () => {
    mockSw({ phase: 'paired' });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-manage-form')).toBeTruthy());
    expect(screen.getByTestId('tip-policy-creator')).toBeTruthy();
    expect(screen.getByTestId('tip-policy-dev')).toBeTruthy();
    // Creator amount seeded from 1000 base units → "1" $DIG.
    expect((screen.getByTestId('tip-creator-amount') as HTMLInputElement).value).toBe('1');
    // Per-site overrides editor present for the creator policy only.
    expect(screen.getByTestId('tip-creator-overrides')).toBeTruthy();
    expect(screen.queryByTestId('tip-dev-overrides')).toBeNull();
  });

  it('gates the form behind pairing when unpaired', async () => {
    mockSw({ phase: 'unpaired' });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    // The pairing gate renders (control-pairing) and the editable form does NOT.
    await waitFor(() => expect(screen.getByTestId('control-pairing')).toBeTruthy());
    expect(screen.queryByTestId('tip-manage-form')).toBeNull();
  });

  it('saves an edited config as base units via tip.set_config', async () => {
    const setSpy = vi.fn();
    mockSw({ phase: 'paired', setSpy });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-manage-form')).toBeTruthy());
    fireEvent.change(screen.getByTestId('tip-creator-amount'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('tip-manage-save'));
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const sent = setSpy.mock.calls[0][0] as { creator: { dig_amount: number } };
    expect(sent.creator.dig_amount).toBe(2500); // 2.5 $DIG → 2500 base units
  });

  it('adds and removes a per-store override, and saves it as base units', async () => {
    const setSpy = vi.fn();
    mockSw({ phase: 'paired', setSpy });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-manage-form')).toBeTruthy());

    // Add an override: store id + 3 $DIG → 3000 base units.
    fireEvent.change(screen.getByTestId('tip-override-store'), { target: { value: 'store-xyz' } });
    fireEvent.change(screen.getByTestId('tip-override-amount'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('tip-override-add'));
    await waitFor(() => expect(screen.getAllByTestId('tip-override-entry').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId('tip-manage-save'));
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const sent = setSpy.mock.calls[0][0] as { creator: { per_site_overrides: Record<string, number> } };
    expect(sent.creator.per_site_overrides['store-xyz']).toBe(3000);

    // Remove the first override.
    const before = screen.getAllByTestId('tip-override-entry').length;
    fireEvent.click(screen.getAllByTestId('tip-override-remove')[0]);
    await waitFor(() => expect(screen.queryAllByTestId('tip-override-entry').length).toBe(before - 1));
  });

  it('toggles the dev policy and switches the creator mode to the daily budget', async () => {
    const setSpy = vi.fn();
    mockSw({ phase: 'paired', setSpy });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-manage-form')).toBeTruthy());
    // The dev policy starts disabled (fixture) — flip it ON, and pick daily-budget mode for the creator.
    fireEvent.click(screen.getByTestId('tip-dev-enable'));
    fireEvent.click(within(screen.getByTestId('tip-policy-creator')).getByTestId('seg-daily-budget'));
    fireEvent.click(screen.getByTestId('tip-manage-save'));
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const sent = setSpy.mock.calls[0][0] as { creator: { mode: string }; dev: { enabled: boolean } };
    expect(sent.creator.mode).toBe('daily-budget');
    expect(sent.dev.enabled).toBe(true);
  });

  it('blocks save + shows an error when an amount is malformed', async () => {
    mockSw({ phase: 'paired' });
    renderWithProviders(<ManageAutoTipSection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-manage-form')).toBeTruthy());
    fireEvent.change(screen.getByTestId('tip-creator-amount'), { target: { value: '1.2.3' } });
    await waitFor(() => expect(screen.getByTestId('tip-manage-invalid')).toBeTruthy());
    expect((screen.getByTestId('tip-manage-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
