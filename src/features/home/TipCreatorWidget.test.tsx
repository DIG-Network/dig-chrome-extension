import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TipCreatorWidget } from '@/features/home/TipCreatorWidget';
import { AUTOTIP_CONFIG_KEY } from '@/lib/autoTip';

const CAPSULE = { storeId: 'a'.repeat(64), rootHash: 'b'.repeat(64) };

/** SW mock: getShieldLedger yields the active-tab capsule (or null); tipCreator returns the flagged
 *  stub (the dig-node tipping subsystem #377 is not built). */
function mockSw(opts: { capsule?: unknown } = {}) {
  const capsule = 'capsule' in opts ? opts.capsule : CAPSULE;
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
      let reply: unknown = { success: true };
      if (msg?.action === 'getShieldLedger') reply = { capsule, verification: null, group: {}, entries: [] };
      else if (msg?.action === 'tipCreator')
        reply = { success: false, code: 'TIP_SUBSYSTEM_UNAVAILABLE', message: 'not built yet' };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

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

beforeEach(() => mockStorage());
afterEach(() => vi.restoreAllMocks());

describe('TipCreatorWidget (#379)', () => {
  it('shows the tip prompt when a DIG resource is loaded and auto-tip is off', async () => {
    mockSw();
    renderWithProviders(<TipCreatorWidget />);
    expect(await screen.findByTestId('tip-creator-widget')).toBeInTheDocument();
    expect(screen.getByTestId('tip-creator-send')).toBeInTheDocument();
    expect(screen.getByTestId('tip-creator-setup')).toBeInTheDocument();
  });

  it('renders nothing on a non-DIG page (no capsule) — the Home board is unchanged', async () => {
    mockSw({ capsule: null });
    renderWithProviders(<TipCreatorWidget />);
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalled());
    expect(screen.queryByTestId('tip-creator-widget')).toBeNull();
  });

  it('hides when auto-tip is enabled (the node handles tipping unattended)', async () => {
    mockStorage({ [AUTOTIP_CONFIG_KEY]: { enabled: true, amountDig: '1', mode: 'per-site-per-day', perSiteOverrides: {} } });
    mockSw();
    renderWithProviders(<TipCreatorWidget />);
    // Even with a capsule present, an enabled config keeps the manual prompt hidden.
    await waitFor(() => expect(screen.queryByTestId('tip-creator-widget')).toBeNull());
  });

  it('surfaces the honest "coming soon" error when the (stubbed) node tip call fails', async () => {
    mockSw();
    renderWithProviders(<TipCreatorWidget />);
    fireEvent.click(await screen.findByTestId('tip-creator-send'));
    expect(await screen.findByTestId('tip-creator-error')).toBeInTheDocument();
  });

  it('is dismissible (§6.0 — never gates consumption)', async () => {
    mockSw();
    renderWithProviders(<TipCreatorWidget />);
    fireEvent.click(await screen.findByTestId('tip-creator-dismiss'));
    expect(screen.queryByTestId('tip-creator-widget')).toBeNull();
  });
});
