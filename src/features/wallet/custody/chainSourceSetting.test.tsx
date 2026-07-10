import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ChainSourceSetting } from '@/features/wallet/custody/ChainSourceSetting';
import { ACTIONS } from '@/lib/messages';

/**
 * The wallet-data SOURCE switch (#217 EXT-2, design D.3): a 4-state control (auto / dig-node /
 * coinset / custom) persisted to `wallet.settings` and mirrored into the `ui` slice. Drives it over
 * the mocked `chrome.storage.local` stub (vitest.setup) the same way the other Settings components
 * are tested.
 */

const SETTINGS_KEY = 'wallet.settings';

async function readStored(): Promise<Record<string, unknown>> {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  return (out[SETTINGS_KEY] as Record<string, unknown>) ?? {};
}

beforeEach(async () => {
  await chrome.storage.local.set({ [SETTINGS_KEY]: {} });
});

describe('ChainSourceSetting (#217)', () => {
  it('renders the four source modes, defaulting to auto', async () => {
    renderWithProviders(<ChainSourceSetting />);
    const select = (await screen.findByTestId('chain-source-select')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'node', 'coinset', 'custom']);
    await waitFor(() => expect(select.value).toBe('auto'));
    // No custom-URL field while not in custom mode.
    expect(screen.queryByTestId('chain-source-custom')).not.toBeInTheDocument();
  });

  it('hydrates the persisted mode from wallet.settings', async () => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { chainSourceMode: 'node' } });
    renderWithProviders(<ChainSourceSetting />);
    const select = (await screen.findByTestId('chain-source-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('node'));
  });

  it('persists a non-custom mode immediately + mirrors it into the ui slice', async () => {
    const { store } = renderWithProviders(<ChainSourceSetting />);
    const select = await screen.findByTestId('chain-source-select');
    fireEvent.change(select, { target: { value: 'coinset' } });
    await screen.findByTestId('chain-source-saved');
    expect((await readStored()).chainSourceMode).toBe('coinset');
    expect(store.getState().ui.chainSource).toBe('coinset');
  });

  it('reveals the custom-URL field in custom mode and persists the entered URL on blur', async () => {
    const { store } = renderWithProviders(<ChainSourceSetting />);
    const select = await screen.findByTestId('chain-source-select');
    fireEvent.change(select, { target: { value: 'custom' } });
    const input = await screen.findByTestId('chain-source-url');
    fireEvent.change(input, { target: { value: 'http://my-node:9778' } });
    fireEvent.blur(input);
    await waitFor(async () => expect((await readStored()).chainSourceUrl).toBe('http://my-node:9778'));
    const stored = await readStored();
    expect(stored.chainSourceMode).toBe('custom');
    expect(store.getState().ui.chainSourceUrl).toBe('http://my-node:9778');
  });

  it('shows a mode-specific hint', async () => {
    renderWithProviders(<ChainSourceSetting />);
    const select = await screen.findByTestId('chain-source-select');
    // Auto hint mentions the fallback.
    expect(screen.getByText(/otherwise fall back to coinset\.org/i)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'node' } });
    await waitFor(() => expect(screen.getByText(/Always read from your local dig-node/i)).toBeInTheDocument());
  });
});

/**
 * "Local dig-node detected" auto-detect indicator (#222) — actively probes the §5.3 ladder via
 * `getChainSourceStatus` and shows a visible indicator when Auto mode auto-selected a local node,
 * with zero manual server-host/custom-URL configuration.
 */
describe('ChainSourceSetting — local dig-node detected indicator (#222)', () => {
  function mockChainSourceStatus(response: unknown) {
    chrome.runtime.sendMessage = vi.fn((m: { action?: string }, cb?: (r: unknown) => void) => {
      const reply = m && m.action === ACTIONS.getChainSourceStatus ? response : { success: true };
      cb?.(reply);
      return Promise.resolve(reply);
    }) as never;
  }

  it('shows the indicator with the resolved endpoint when Auto mode auto-selected a local node', async () => {
    mockChainSourceStatus({ mode: 'auto', resolved: { kind: 'node', base: 'http://localhost:9778', strict: false } });
    renderWithProviders(<ChainSourceSetting />);
    const pill = await screen.findByTestId('chain-source-detected-pill');
    expect(pill).toHaveAttribute('data-tone', 'good');
    expect(pill).toHaveTextContent('Local dig-node detected');
    expect(pill).toHaveTextContent('http://localhost:9778');
  });

  it('hides the indicator when Auto mode found no reachable node (coinset fallback)', async () => {
    mockChainSourceStatus({ mode: 'auto', resolved: { kind: 'coinset' } });
    renderWithProviders(<ChainSourceSetting />);
    await screen.findByTestId('chain-source-select');
    expect(screen.queryByTestId('chain-source-detected-pill')).not.toBeInTheDocument();
  });

  it('hides the indicator when the mode is forced to "node" — even though a node is reachable', async () => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { chainSourceMode: 'node' } });
    mockChainSourceStatus({ mode: 'node', resolved: { kind: 'node', base: 'http://localhost:9778', strict: true } });
    renderWithProviders(<ChainSourceSetting />);
    const select = (await screen.findByTestId('chain-source-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('node'));
    expect(screen.queryByTestId('chain-source-detected-pill')).not.toBeInTheDocument();
  });
});
