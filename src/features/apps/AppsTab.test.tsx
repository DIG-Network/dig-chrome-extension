import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
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

/** Stub chrome.storage.local so the SWR cache read/write is inert unless a test seeds it. */
function stubStorage(seed?: Record<string, unknown>) {
  const mem: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in mem ? { [key]: mem[key] } : {})),
      set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(mem, obj); }),
    },
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
