import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { HeaderToolbarToggle } from '@/features/toolbar/HeaderToolbarToggle';
import { TOOLBAR_ENABLED_KEY } from '@/lib/toolbar';

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

describe('HeaderToolbarToggle (#306 item 4 — the toolbar switch, inline in the window header)', () => {
  beforeEach(() => mockStorage());

  it('is a role="switch" (not a checkbox), default OFF', async () => {
    renderWithProviders(<HeaderToolbarToggle />);
    const sw = await screen.findByTestId('header-toolbar-toggle');
    expect(sw).toHaveAttribute('role', 'switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('hydrates ON when toolbar.enabled is already persisted true', async () => {
    mockStorage({ [TOOLBAR_ENABLED_KEY]: true });
    renderWithProviders(<HeaderToolbarToggle />);
    await waitFor(() => expect(screen.getByTestId('header-toolbar-toggle')).toHaveAttribute('aria-checked', 'true'));
  });

  it('persists toolbar.enabled=true (the SAME key dig-toolbar.ts + DigToolbar read live)', async () => {
    renderWithProviders(<HeaderToolbarToggle />);
    const sw = await screen.findByTestId('header-toolbar-toggle');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(chrome.storage.local.set as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
        [TOOLBAR_ENABLED_KEY]: true,
      }),
    );
  });
});
