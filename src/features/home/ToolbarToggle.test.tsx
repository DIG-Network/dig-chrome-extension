import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { ToolbarToggle } from '@/features/home/ToolbarToggle';
import { TOOLBAR_ENABLED_KEY } from '@/lib/toolbar';

/** A `chrome.storage.local` mock that actually persists across `get`/`set` (mirrors homeScreen.test's
 *  helper) so the toggle's on/off state can be proven to round-trip. */
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

describe('ToolbarToggle (#293 — Home-tab toolbar enable/disable switch)', () => {
  beforeEach(() => {
    mockStorage();
  });

  it('defaults OFF (opt-in) and shows the inactive status', async () => {
    renderWithProviders(<ToolbarToggle />);
    const checkbox = await screen.findByTestId('home-toolbar-toggle');
    expect(checkbox).not.toBeChecked();
    expect(screen.getByTestId('home-toolbar-toggle-status')).toHaveTextContent(/inactive/i);
  });

  it('hydrates ON when toolbar.enabled is already persisted true', async () => {
    mockStorage({ [TOOLBAR_ENABLED_KEY]: true });
    renderWithProviders(<ToolbarToggle />);
    await waitFor(() => expect(screen.getByTestId('home-toolbar-toggle')).toBeChecked());
    expect(screen.getByTestId('home-toolbar-toggle-status')).toHaveTextContent(/active/i);
  });

  it('toggling ON persists toolbar.enabled=true to chrome.storage.local (the SAME key dig-toolbar.ts reads)', async () => {
    renderWithProviders(<ToolbarToggle />);
    const checkbox = await screen.findByTestId('home-toolbar-toggle');
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    await waitFor(() =>
      expect((chrome.storage.local.set as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ [TOOLBAR_ENABLED_KEY]: true }),
    );
  });

  it('toggling OFF again persists toolbar.enabled=false', async () => {
    mockStorage({ [TOOLBAR_ENABLED_KEY]: true });
    renderWithProviders(<ToolbarToggle />);
    const checkbox = await screen.findByTestId('home-toolbar-toggle');
    await waitFor(() => expect(checkbox).toBeChecked());
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await waitFor(() =>
      expect((chrome.storage.local.set as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ [TOOLBAR_ENABLED_KEY]: false }),
    );
  });
});
