import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { NodeVersionSection } from '@/features/updates/NodeVersionSection';
import { feedManifestUrl } from '@/lib/feed-manifest';

interface Sent {
  action?: string;
  method?: string;
}

/** Stub the SW seam: answer `getNodeLiveStatus` with a fixed snapshot and, when the beacon is
 *  installed, answer `control.updater.status` with a tracked `channel` (so the channel-aware badge
 *  can derive which feed to compare against, #606). Every other action resolves to `{ success: true }`. */
function mockSw(live: { state: string; version: string | null }, beaconChannel?: string) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      let r: unknown = { success: true };
      if (msg?.action === 'getNodeLiveStatus') r = { ...live, base: null, addr: null, commit: null, updatedAt: 0 };
      else if (msg?.action === 'controlAuthed' && msg.method === 'control.updater.status') {
        r = beaconChannel
          ? { installed: true, status: { schema: 1, version: '0.6.0', channel: beaconChannel, paused: false } }
          : { installed: false };
      }
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

/** Stub the direct-HTTPS feed-manifest fetch, keyed by the exact per-channel URL requested. Any
 *  other URL rejects, so a wrong-channel fetch fails the test loudly (a SEPARATE transport from the
 *  SW seam, see feedManifestApi.ts). */
function mockFeed(url: string, components: { name: string; version: string }[] | 'unreachable') {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    if (String(input) !== url) return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    if (components === 'unreachable') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, json: async () => ({ manifest: { components } }) } as Response);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('NodeVersionSection (#583)', () => {
  it('shows an honest "node offline" badge — never a false "up to date" — when the node is not connected', async () => {
    mockSw({ state: 'disconnected', version: null });
    mockFeed(feedManifestUrl('stable'), [{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-badge')).toHaveTextContent(/offline/i);
    expect(screen.queryByTestId('updates-node-version-value')).toBeNull();
  });

  it('shows "couldn\'t check for updates" — never a false "up to date" — when the feed is unreachable', async () => {
    mockSw({ state: 'connected', version: '0.31.1' });
    mockFeed(feedManifestUrl('stable'), 'unreachable');
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.31.1');
    expect(screen.getByTestId('updates-node-version-badge')).toHaveTextContent(/couldn.t check/i);
  });

  it('shows "up to date" when the running version matches the feed\'s latest', async () => {
    mockSw({ state: 'connected', version: '0.31.1' });
    mockFeed(feedManifestUrl('stable'), [{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.31.1');
    expect(screen.getByTestId('updates-node-version-badge')).toHaveTextContent(/up to date/i);
  });

  it('shows "update available — vX.Y.Z" when the running version is behind the feed', async () => {
    mockSw({ state: 'connected', version: '0.30.0' });
    mockFeed(feedManifestUrl('stable'), [{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.30.0');
    const badge = screen.getByTestId('updates-node-version-badge');
    expect(badge).toHaveTextContent(/update available/i);
    expect(badge).toHaveTextContent('0.31.1');
  });

  it('compares against the NIGHTLY feed when the beacon tracks the nightly channel (#606)', async () => {
    // The node runs a nightly build; the badge must compare it against the nightly feed, not the
    // stable one — the stable URL rejects in this mock, so a wrong-channel fetch would fail here.
    mockSw({ state: 'connected', version: '0.32.0-nightly.20260714' }, 'nightly');
    mockFeed(feedManifestUrl('nightly'), [{ name: 'dig-node', version: '0.32.0-nightly.20260715' }]);
    renderWithProviders(<NodeVersionSection />);
    // Wait for the verdict text specifically: the badge element mounts first with an interim
    // "checking" state while the tracked channel resolves, so asserting on the element alone would
    // race. Seeing "update available" proves the nightly feed (not stable) was the comparison basis.
    expect(await screen.findByText(/update available/i)).toBeTruthy();
    expect(screen.getByTestId('updates-node-version-badge')).toHaveTextContent(/update available/i);
  });
});
