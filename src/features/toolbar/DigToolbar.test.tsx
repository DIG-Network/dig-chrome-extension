import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setTheme } from '@/features/ui/uiSlice';
import { readWalletSettings } from '@/features/wallet/custody/settings';
import { DigToolbar } from '@/features/toolbar/DigToolbar';
import { TOOLBAR_ENABLED_KEY, TOOLBAR_THEME_KEY } from '@/lib/toolbar';

const STORE = 'a'.repeat(64);
const sendMessage = () => chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

async function enable(on: boolean) {
  if (on) await chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: true });
  else await chrome.storage.local.remove(TOOLBAR_ENABLED_KEY);
}

/** Read the toolbar's OWN independent persisted theme key (never `wallet.settings.theme`). */
async function readToolbarTheme(): Promise<string | undefined> {
  const out = await chrome.storage.local.get(TOOLBAR_THEME_KEY);
  return out[TOOLBAR_THEME_KEY] as string | undefined;
}

describe('DigToolbar — built-in fullscreen URN toolbar (#306 item 1)', () => {
  beforeEach(async () => {
    sendMessage().mockClear();
    await enable(false);
    await chrome.storage.local.remove('wallet.settings');
    await chrome.storage.local.remove(TOOLBAR_THEME_KEY);
  });

  it('renders nothing while the toolbar toggle is OFF', async () => {
    const { container } = renderWithProviders(<DigToolbar />);
    // give useStorageValue a tick to hydrate the (absent) value
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="builtin-dig-toolbar"]')).toBeNull();
  });

  it('shows the URN bar when enabled and routes a chia:// address via navigateToDigUrl (#289 path)', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, `chia://${STORE}{Enter}`);
    await waitFor(() =>
      expect(sendMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigateToDigUrl', url: expect.stringContaining(STORE) }),
        expect.any(Function),
      ),
    );
  });

  it('routes an *.on.dig.net shorthand via navigateDigInput (HEAD→URN #308)', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, 'shop.on.dig.net{Enter}');
    await waitFor(() =>
      expect(sendMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigateDigInput', input: 'shop.on.dig.net' }),
        expect.any(Function),
      ),
    );
  });

  it('#308 — rewrites a bare *.on.dig.net submit to the canonical chia:// form (never to localhost)', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const input = (await screen.findByTestId('builtin-dig-toolbar-urn-input')) as HTMLInputElement;
    await userEvent.type(input, 'shop.on.dig.net{Enter}');
    // The visible URN bar shows the canonical chia:// address for the subdomain — NOT the local
    // node URL the content actually loads from (the tab navigates to the node /s/ surface separately).
    await waitFor(() => expect(input.value).toBe('chia://shop.on.dig.net'));
  });

  it('#308 — accepts the canonical chia://<sub>.on.dig.net form and routes it HEAD→URN', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const input = (await screen.findByTestId('builtin-dig-toolbar-urn-input')) as HTMLInputElement;
    await userEvent.type(input, 'chia://shop.on.dig.net{Enter}');
    await waitFor(() =>
      expect(sendMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigateDigInput', input: 'shop.on.dig.net' }),
        expect.any(Function),
      ),
    );
    expect(input.value).toBe('chia://shop.on.dig.net');
  });

  it('marks the field invalid on non-DIG input instead of navigating', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, 'just some words{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(sendMessage()).not.toHaveBeenCalled();
  });

  it('renders the verified + local badges when a node serve verdict is supplied', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar verdict={{ verified: true, root: null, source: 'local' }} />);
    expect(await screen.findByTestId('builtin-dig-toolbar-badge-verified')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('builtin-dig-toolbar-badge-local')).toBeInTheDocument();
  });

  it('#366 — shows the show/hide keyboard-shortcut hint (default when chrome.commands is unresolved)', async () => {
    await enable(true);
    renderWithProviders(<DigToolbar />);
    const hint = await screen.findByTestId('builtin-dig-toolbar-shortcut-hint');
    // With no chrome.commands binding resolvable in the unit env, the manifest default is shown.
    expect(hint).toHaveTextContent('Alt+Shift+D');
    expect(hint).toHaveTextContent(/show\/hide/i);
  });

  // ── #429/#459 — the light/dark theme switcher button in the URN bar, INDEPENDENT of the app theme
  describe('#429 — light/dark theme toggle', () => {
    it('renders a labelled toggle button; the default (light) is not pressed', async () => {
      await enable(true);
      renderWithProviders(<DigToolbar />);
      const btn = await screen.findByTestId('builtin-dig-toolbar-theme-toggle');
      // Accessible: a real toggle button with a stable name + pressed state (WAI-ARIA APG).
      expect(btn.tagName).toBe('BUTTON');
      expect(btn).toHaveAttribute('aria-pressed', 'false'); // system → light in the jsdom test env
      expect(btn).toHaveAccessibleName(/theme/i);
      // The bar paints light by default (matches the ext-page white product theme).
      expect(screen.getByTestId('builtin-dig-toolbar')).toHaveAttribute('data-theme', 'light');
    });

    it('is keyboard-operable: focusing + pressing Enter flips the theme (§6.6)', async () => {
      await enable(true);
      renderWithProviders(<DigToolbar />);
      const btn = await screen.findByTestId('builtin-dig-toolbar-theme-toggle');
      btn.focus();
      expect(btn).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      expect(btn).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('builtin-dig-toolbar')).toHaveAttribute('data-theme', 'dark');
    });

    it('clicking flips the bar to dark and persists under the toolbar\'s OWN key — NOT wallet.settings.theme (#459)', async () => {
      await enable(true);
      const { store } = renderWithProviders(<DigToolbar />);
      const btn = await screen.findByTestId('builtin-dig-toolbar-theme-toggle');
      const appThemeBefore = store.getState().ui.theme;

      await userEvent.click(btn);

      // Bar repaints dark + the toggle reflects the pressed state.
      expect(screen.getByTestId('builtin-dig-toolbar')).toHaveAttribute('data-theme', 'dark');
      expect(btn).toHaveAttribute('aria-pressed', 'true');
      // Persisted under toolbar.theme (read-modify-write via useStorageValue) — never wallet.settings.
      await waitFor(async () => expect(await readToolbarTheme()).toBe('dark'));
      expect((await readWalletSettings()).theme).toBeUndefined();
      // The main app theme is UNTOUCHED by the URN-bar toggle (the decoupling this ticket fixes).
      expect(store.getState().ui.theme).toBe(appThemeBefore);
    });

    it('when the stored toolbar pref is dark the bar paints dark; toggling returns to explicit light + persists (own key)', async () => {
      await enable(true);
      await chrome.storage.local.set({ [TOOLBAR_THEME_KEY]: 'dark' });
      renderWithProviders(<DigToolbar />);

      const bar = await screen.findByTestId('builtin-dig-toolbar');
      await waitFor(() => expect(bar).toHaveAttribute('data-theme', 'dark'));
      const btn = screen.getByTestId('builtin-dig-toolbar-theme-toggle');
      expect(btn).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(btn);

      expect(bar).toHaveAttribute('data-theme', 'light');
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      await waitFor(async () => expect(await readToolbarTheme()).toBe('light'));
    });

    it('#459 — toggling the MAIN app theme (uiSlice.theme) does NOT move the URN-bar theme (reverse-direction proof)', async () => {
      await enable(true);
      const store = createStore();
      renderWithProviders(<DigToolbar />, { store });

      const bar = await screen.findByTestId('builtin-dig-toolbar');
      const btn = await screen.findByTestId('builtin-dig-toolbar-theme-toggle');
      await waitFor(() => expect(bar).toHaveAttribute('data-theme', 'light'));
      expect(btn).toHaveAttribute('aria-pressed', 'false');

      // Flip the APP theme the way AppFooter's theme-select does — the URN bar must not react.
      store.dispatch(setTheme('dark'));

      expect(bar).toHaveAttribute('data-theme', 'light');
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      expect(await readToolbarTheme()).toBeUndefined(); // never written by the app-theme change
    });
  });
});
