import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { AppView } from '@/features/apps/AppView';
import { setOpenApp } from '@/features/ui/uiSlice';

// A DIG dApp on on.dig.net — needs the framing bypass to embed in-window (#66).
const DIG_APP = { slug: 'chia-offer', name: 'Chia-Offer', link: 'https://chia-offer.on.dig.net/' };
// A non-DIG external dApp — no bypass; keeps the iframe-or-tab-fallback behaviour.
const EXT_APP = { slug: 'ext', name: 'External', link: 'https://example.com/' };

/** A store with a dApp already launched into the app-view. */
function openedStore(app: typeof DIG_APP = DIG_APP) {
  const store = createStore();
  store.dispatch(setOpenApp(app));
  return store;
}

/** Spy on the SW message channel so we can assert (and drive) the appViewFraming requests. */
function spySendMessage() {
  const fn = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
    if (cb) cb({ success: true });
    return Promise.resolve({ success: true });
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

beforeEach(() => {
  (chrome as unknown as { tabs: unknown }).tabs = { create: vi.fn() };
  (chrome.runtime as unknown as { id: string }).id = 'test-ext';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AppView (in-window dApp app-view)', () => {
  it('renders nothing when no dApp is open', () => {
    renderWithProviders(<AppView />);
    expect(screen.queryByTestId('appview')).not.toBeInTheDocument();
  });

  it('installs the on.dig.net framing bypass, then embeds the dApp in-window (#66)', async () => {
    const send = spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(DIG_APP) });
    // The bypass is requested before the frame is shown.
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'appViewFraming', enable: true }),
        expect.any(Function),
      ),
    );
    const frame = await screen.findByTestId('appview-frame');
    expect(frame.getAttribute('src')).toBe(DIG_APP.link);
    expect(screen.getByTestId('appview-title')).toHaveTextContent('Chia-Offer');
    expect(screen.getByTestId('appview-back')).toBeInTheDocument();
    expect(screen.getByTestId('appview-expand')).toBeInTheDocument();
  });

  it('removes the framing bypass when the on.dig.net view closes', async () => {
    const send = spySendMessage();
    const store = openedStore(DIG_APP);
    renderWithProviders(<AppView />, { store });
    await screen.findByTestId('appview-frame'); // bypass installed
    send.mockClear();
    fireEvent.click(screen.getByTestId('appview-back'));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'appViewFraming', enable: false }),
        expect.any(Function),
      ),
    );
    expect(store.getState().ui.openApp).toBeNull();
  });

  it('embeds a non-DIG dApp immediately with NO framing bypass request', () => {
    const send = spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(EXT_APP) });
    const frame = screen.getByTestId('appview-frame');
    expect(frame.getAttribute('src')).toBe(EXT_APP.link);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'appViewFraming' }),
      expect.any(Function),
    );
  });

  it('goes ready when a real cross-origin dApp loads (location read throws)', async () => {
    spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(DIG_APP) });
    const frame = await screen.findByTestId('appview-frame');
    // Simulate a successfully-loaded cross-origin frame: reading its location throws a SecurityError.
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      get: () => ({ get location(): never { throw new Error('cross-origin'); } }),
    });
    fireEvent.load(frame);
    expect(screen.queryByTestId('appview-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appview-blocked')).not.toBeInTheDocument();
    expect(screen.getByTestId('appview-frame')).toBeVisible();
  });

  it('detects a refused embed that fires load on a blank document → blocked', () => {
    spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(EXT_APP) });
    const frame = screen.getByTestId('appview-frame');
    // A refused frame (X-Frame-Options / frame-ancestors) fires load but stays a readable about:blank.
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      get: () => ({ location: { href: 'about:blank' } }),
    });
    fireEvent.load(frame);
    expect(screen.getByTestId('appview-blocked')).toBeInTheDocument();
  });

  it('moves focus to the Back control on open (WCAG — lands inside the dialog)', () => {
    spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(EXT_APP) });
    expect(document.activeElement).toBe(screen.getByTestId('appview-back'));
  });

  it('back closes the app-view', () => {
    spySendMessage();
    const store = openedStore(EXT_APP);
    renderWithProviders(<AppView />, { store });
    fireEvent.click(screen.getByTestId('appview-back'));
    expect(store.getState().ui.openApp).toBeNull();
  });

  it('expand opens the dApp in a full tab and closes the view', () => {
    spySendMessage();
    const store = openedStore(EXT_APP);
    renderWithProviders(<AppView />, { store });
    fireEvent.click(screen.getByTestId('appview-expand'));
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: EXT_APP.link });
    expect(store.getState().ui.openApp).toBeNull();
  });

  it('on a refused embed (load timeout) shows the blocked note + opens a new tab (never blank)', () => {
    vi.useFakeTimers();
    spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(EXT_APP) });
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    expect(screen.getByTestId('appview-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('appview-open-tab')).toBeInTheDocument();
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: EXT_APP.link });
  });

  it('the blocked "open in a new tab" button re-opens the dApp', () => {
    vi.useFakeTimers();
    spySendMessage();
    renderWithProviders(<AppView />, { store: openedStore(EXT_APP) });
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    (chrome.tabs.create as unknown as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByTestId('appview-open-tab'));
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: EXT_APP.link });
  });
});
