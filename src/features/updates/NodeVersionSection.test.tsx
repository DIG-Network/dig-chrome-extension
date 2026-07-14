import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { NodeVersionSection } from '@/features/updates/NodeVersionSection';
import { UPDATE_FEED_MANIFEST_URL } from '@/lib/feed-manifest';

interface Sent {
  action?: string;
}

/** Stub `getNodeLiveStatus` (the SW seam) to answer a fixed live-status snapshot. Every other action
 *  resolves to the default `{ success: true }` the vitest.setup.ts stub already returns. */
function mockLiveStatus(status: { state: string; version: string | null }) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const r = msg?.action === 'getNodeLiveStatus' ? { ...status, base: null, addr: null, commit: null, updatedAt: 0 } : { success: true };
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

/** Stub the direct-HTTPS feed-manifest fetch (a SEPARATE transport from the SW seam, see feedManifestApi.ts). */
function mockFeed(components: { name: string; version: string }[] | 'unreachable') {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    if (String(input) !== UPDATE_FEED_MANIFEST_URL) return Promise.reject(new Error('unexpected fetch'));
    if (components === 'unreachable') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, json: async () => ({ manifest: { components } }) } as Response);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('NodeVersionSection (#583)', () => {
  it('shows an honest "node offline" badge — never a false "up to date" — when the node is not connected', async () => {
    mockLiveStatus({ state: 'disconnected', version: null });
    mockFeed([{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-badge')).toHaveTextContent(/offline/i);
    expect(screen.queryByTestId('updates-node-version-value')).toBeNull();
  });

  it('shows "couldn\'t check for updates" — never a false "up to date" — when the feed is unreachable', async () => {
    mockLiveStatus({ state: 'connected', version: '0.31.1' });
    mockFeed('unreachable');
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.31.1');
    expect(screen.getByTestId('updates-node-version-badge')).toHaveTextContent(/couldn.t check/i);
  });

  it('shows "up to date" when the running version matches the feed\'s latest', async () => {
    mockLiveStatus({ state: 'connected', version: '0.31.1' });
    mockFeed([{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.31.1');
    expect(screen.getByTestId('updates-node-version-badge')).toHaveTextContent(/up to date/i);
  });

  it('shows "update available — vX.Y.Z" when the running version is behind the feed', async () => {
    mockLiveStatus({ state: 'connected', version: '0.30.0' });
    mockFeed([{ name: 'dig-node', version: '0.31.1' }]);
    renderWithProviders(<NodeVersionSection />);
    expect(await screen.findByTestId('updates-node-version-value')).toHaveTextContent('0.30.0');
    const badge = screen.getByTestId('updates-node-version-badge');
    expect(badge).toHaveTextContent(/update available/i);
    expect(badge).toHaveTextContent('0.31.1');
  });
});
