import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { AppView } from '@/features/apps/AppView';
import { setOpenApp } from '@/features/ui/uiSlice';

const APP = { slug: 'chia-offer', name: 'Chia-Offer', link: 'https://chia-offer.on.dig.net/' };

/** A store with a dApp already launched into the app-view. */
function openedStore() {
  const store = createStore();
  store.dispatch(setOpenApp(APP));
  return store;
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

  it('opens the dApp in an iframe with a loading state, back, and expand controls', () => {
    renderWithProviders(<AppView />, { store: openedStore() });
    expect(screen.getByTestId('appview')).toBeInTheDocument();
    expect(screen.getByTestId('appview-title')).toHaveTextContent('Chia-Offer');
    expect(screen.getByTestId('appview-loading')).toBeInTheDocument();
    const frame = screen.getByTestId('appview-frame');
    expect(frame.getAttribute('src')).toBe(APP.link);
    expect(screen.getByTestId('appview-back')).toBeInTheDocument();
    expect(screen.getByTestId('appview-expand')).toBeInTheDocument();
  });

  it('goes ready when a real cross-origin dApp loads (location read throws)', () => {
    renderWithProviders(<AppView />, { store: openedStore() });
    const frame = screen.getByTestId('appview-frame');
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
    renderWithProviders(<AppView />, { store: openedStore() });
    const frame = screen.getByTestId('appview-frame');
    // A refused frame (X-Frame-Options / frame-ancestors) fires load but stays a readable about:blank.
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      get: () => ({ location: { href: 'about:blank' } }),
    });
    fireEvent.load(frame);
    expect(screen.getByTestId('appview-blocked')).toBeInTheDocument();
  });

  it('back closes the app-view', () => {
    const store = openedStore();
    renderWithProviders(<AppView />, { store });
    fireEvent.click(screen.getByTestId('appview-back'));
    expect(store.getState().ui.openApp).toBeNull();
  });

  it('expand opens the dApp in a full tab and closes the view', () => {
    const store = openedStore();
    renderWithProviders(<AppView />, { store });
    fireEvent.click(screen.getByTestId('appview-expand'));
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: APP.link });
    expect(store.getState().ui.openApp).toBeNull();
  });

  it('on a refused embed (load timeout) shows the blocked note + opens a new tab (never blank)', () => {
    vi.useFakeTimers();
    renderWithProviders(<AppView />, { store: openedStore() });
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    expect(screen.getByTestId('appview-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('appview-open-tab')).toBeInTheDocument();
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: APP.link });
  });

  it('the blocked "open in a new tab" button re-opens the dApp', () => {
    vi.useFakeTimers();
    renderWithProviders(<AppView />, { store: openedStore() });
    act(() => {
      vi.advanceTimersByTime(6500);
    });
    (chrome.tabs.create as unknown as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByTestId('appview-open-tab'));
    expect((chrome.tabs.create as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ url: APP.link });
  });
});
