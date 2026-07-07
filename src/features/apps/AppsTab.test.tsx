import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { AppsTab } from '@/features/apps/AppsTab';
import { renderWithProviders } from '@/test/harness';
import { STORE_CACHE_KEY } from '@/features/apps/storeCatalog';

const CATALOG = {
  generatedAt: '2026-07-05T00:00:00Z',
  version: '0.5.0',
  apps: [
    { slug: 'chia-offer', name: 'Chia-Offer', icon: 'https://explore.dig.net/catalog/chia-offer/icon-512.png', link: 'https://chia-offer.on.dig.net/', category: 'tools', featured: true, accentColor: '#3aaa35' },
    { slug: 'hashtunes', name: 'HashTunes', icon: 'https://explore.dig.net/catalog/hashtunes/icon-512.png', link: 'https://hashtunes.on.dig.net/', category: 'tools', featured: false, accentColor: '#fb81ed' },
  ],
};

/** Stub chrome.storage.local so the SWR cache read/write is inert unless a test seeds it. Also
 * provides `.remove` + an inert `.onChanged` (unused by these tests) so every storage-backed hook
 * (SWR cache, personalization) can read/write the SAME in-memory `mem`, including across a
 * simulated popup-reopen (a second `renderWithProviders` call reusing this `mem`). */
function stubStorage(seed?: Record<string, unknown>) {
  const mem: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in mem ? { [key]: mem[key] } : {})),
      set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(mem, obj); }),
      remove: vi.fn(async (key: string) => { delete mem[key]; }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return mem;
}

beforeEach(() => stubStorage());
afterEach(() => vi.restoreAllMocks());

describe('AppsTab launcher', () => {
  it('renders a native icon grid from /store.json (featured first), no iframe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    renderWithProviders(<AppsTab />);

    expect(await screen.findByTestId('apps-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-hashtunes')).toBeInTheDocument();
    // Tiles are buttons that launch the in-window app-view (§2.4a), NOT plain links; no iframe here.
    expect(screen.getByTestId('app-tile-chia-offer').tagName).toBe('BUTTON');
    expect(screen.getByTestId('app-tile-chia-offer')).toHaveAttribute('aria-label', 'Open Chia-Offer');
    expect(screen.queryByTestId('apps-frame')).not.toBeInTheDocument();
    // Icon uses the remote absolute URL.
    const img = screen.getByTestId('app-icon-chia-offer').querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://explore.dig.net/catalog/chia-offer/icon-512.png');
  });

  it('shows an error + retry when the store is unavailable and no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderWithProviders(<AppsTab />);
    expect(await screen.findByTestId('apps-error')).toBeInTheDocument();
    expect(screen.getByTestId('apps-retry')).toBeInTheDocument();
  });

  it('falls back to the cached catalog offline (stale-while-revalidate) and flags it', async () => {
    stubStorage({ [STORE_CACHE_KEY]: { apps: CATALOG.apps, at: Date.now() } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderWithProviders(<AppsTab />);
    expect(await screen.findByTestId('apps-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
    expect(screen.getByTestId('apps-offline')).toBeInTheDocument();
  });

  it('shows an empty state when the catalog has no apps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ apps: [] }) })));
    renderWithProviders(<AppsTab />);
    expect(await screen.findByTestId('apps-empty')).toBeInTheDocument();
  });
});

describe('AppsTab personalization (#164)', () => {
  it('keyboard-reorders a tile in edit mode and persists the order across popup reopen', async () => {
    const mem = stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');

    // Enter edit mode — reorder controls appear.
    fireEvent.click(screen.getByTestId('apps-edit-toggle'));
    expect(screen.getByTestId('app-move-up-hashtunes')).toBeInTheDocument();

    // hashtunes is 2nd (index 1) — move it up one slot, ahead of chia-offer.
    fireEvent.click(screen.getByTestId('app-move-up-hashtunes'));

    const orderNow = () => screen.getAllByTestId(/^app-tile-(?!wrap-)/).map((el) => el.getAttribute('data-testid'));
    expect(orderNow()).toEqual(['app-tile-hashtunes', 'app-tile-chia-offer']);
    // The move is announced for a screen-reader user (a11y §6.6).
    expect(screen.getByTestId('apps-announce').textContent).toMatch(/HashTunes/);

    void mem; // the persisted personalization now lives in mem, keyed by APPS_PERSONALIZATION_KEY

    // Simulate a popup reopen: a fresh mount reading the SAME storage.
    cleanup();
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');
    expect(orderNow()).toEqual(['app-tile-hashtunes', 'app-tile-chia-offer']);
  });

  it('hides an app from the grid and restores it via "show hidden" → unhide', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');

    fireEvent.click(screen.getByTestId('apps-edit-toggle'));
    fireEvent.click(screen.getByTestId('app-hide-hashtunes'));

    // Gone from the main grid; no longer editable-reorderable since it isn't rendered at all.
    expect(screen.queryByTestId('app-tile-hashtunes')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();

    // Recoverable via "Show hidden (1)".
    const hiddenToggle = screen.getByTestId('apps-hidden-toggle');
    expect(hiddenToggle.textContent).toMatch(/1/);
    fireEvent.click(hiddenToggle);
    expect(screen.getByTestId('hidden-app-hashtunes')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('app-unhide-hashtunes'));
    expect(screen.queryByTestId('hidden-app-hashtunes')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-tile-hashtunes')).toBeInTheDocument();
  });

  it('drag-and-drop reorders tiles in edit mode', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');
    fireEvent.click(screen.getByTestId('apps-edit-toggle'));

    const source = screen.getByTestId('app-tile-wrap-chia-offer');
    const target = screen.getByTestId('app-tile-wrap-hashtunes');
    // A real browser always supplies `dataTransfer`; assert the effect + payload are set on it too
    // (the ref, not this payload, drives the actual reorder — dataTransfer is browser affordance).
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '0');

    const orderNow = screen.getAllByTestId(/^app-tile-(?!wrap-)/).map((el) => el.getAttribute('data-testid'));
    expect(orderNow).toEqual(['app-tile-hashtunes', 'app-tile-chia-offer']);
  });

  it('a newly-added catalog app defaults visible; a removed one drops from the saved order/hidden set', async () => {
    stubStorage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => CATALOG })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          apps: [
            CATALOG.apps[0], // chia-offer survives
            { slug: 'newdapp', name: 'NewDapp', icon: 'https://explore.dig.net/catalog/newdapp/icon.png', link: 'https://newdapp.on.dig.net/', category: 'tools', featured: false },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');

    fireEvent.click(screen.getByTestId('apps-edit-toggle'));
    fireEvent.click(screen.getByTestId('app-hide-hashtunes'));
    expect(screen.queryByTestId('app-tile-hashtunes')).not.toBeInTheDocument();

    // A later catalog refresh drops hashtunes and adds newdapp.
    cleanup();
    renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');
    expect(screen.getByTestId('app-tile-chia-offer')).toBeInTheDocument();
    expect(screen.queryByTestId('app-tile-hashtunes')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-tile-newdapp')).toBeInTheDocument();
    // The hidden set didn't leak a ghost entry for the now-gone hashtunes.
    expect(screen.queryByTestId('apps-hidden-toggle')).not.toBeInTheDocument();
  });
});
