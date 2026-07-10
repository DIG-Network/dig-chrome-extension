import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import {
  UpstreamSection,
  HostedStoresSection,
  SyncSection,
  PeersSection,
} from '@/features/control/ManageSections';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

/** Mock the authed control.* seam by the JSON-RPC `method` each endpoint sends. */
function mockControlAuthed(byMethod: Record<string, unknown>) {
  const calls: { action: string; method?: string; params?: unknown }[] = [];
  chrome.runtime.sendMessage = vi.fn((msg: { action: string; method?: string }, cb?: (r: unknown) => void) => {
    calls.push(msg as never);
    if (msg.action === ACTIONS.controlAuthed && msg.method && msg.method in byMethod) {
      cb?.(byMethod[msg.method]);
    } else {
      cb?.({ success: true });
    }
  }) as never;
  return { calls };
}

describe('ManageSections', () => {
  it('UpstreamSection shows the current upstream and sets a new one', async () => {
    const { calls } = mockControlAuthed({ 'control.config.get': { upstream: 'https://rpc.dig.net/' } });
    renderWithProviders(<UpstreamSection />);
    expect(await screen.findByTestId('control-upstream-current')).toHaveTextContent('https://rpc.dig.net/');
    fireEvent.change(screen.getByTestId('control-upstream-input'), { target: { value: 'https://my.node/' } });
    fireEvent.click(screen.getByTestId('control-upstream-set'));
    await waitFor(() =>
      expect(calls.some((c) => c.action === ACTIONS.controlAuthed && c.method === 'control.config.setUpstream')).toBe(true),
    );
  });

  it('HostedStoresSection lists stores and offers unpin', async () => {
    const { calls } = mockControlAuthed({
      'control.hostedStores.list': { stores: [{ store_id: 'aa', pinned: true, capsule_count: 2, total_bytes: 2048 }] },
    });
    renderWithProviders(<HostedStoresSection />);
    expect(await screen.findByTestId('control-store-entry')).toHaveTextContent('aa');
    expect(screen.getByTestId('control-store-pinned')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('control-store-unpin'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'control.hostedStores.unpin')).toBe(true),
    );
  });

  it('HostedStoresSection shows an empty state with no stores', async () => {
    mockControlAuthed({ 'control.hostedStores.list': { stores: [] } });
    renderWithProviders(<HostedStoresSection />);
    expect(await screen.findByTestId('control-stores-empty')).toBeInTheDocument();
  });

  it('SyncSection reflects §21 availability + coverage', async () => {
    mockControlAuthed({ 'control.sync.status': { available: true, pinned_total: 4, pinned_synced: 3 } });
    renderWithProviders(<SyncSection />);
    expect(await screen.findByTestId('control-sync-pill')).toHaveTextContent(/available/i);
    expect(screen.getByTestId('control-sync-coverage')).toHaveTextContent('3');
    expect(screen.getByTestId('control-sync-coverage')).toHaveTextContent('4');
  });

  it('PeersSection reflects running + peer count', async () => {
    mockControlAuthed({ 'control.peerStatus': { running: true, connected_peers: 5 } });
    renderWithProviders(<PeersSection />);
    expect(await screen.findByTestId('control-peers-pill')).toHaveTextContent(/connected/i);
    expect(screen.getByTestId('control-peers-count')).toHaveTextContent('5');
  });
});
