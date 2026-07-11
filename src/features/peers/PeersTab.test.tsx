import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeersTab } from '@/features/peers/PeersTab';
import { renderWithProviders } from '@/test/harness';

type Reply = unknown;
/** Route sendMessage by action + control method so each test declares its node responses. */
function mockSw(routes: {
  control?: Reply;
  peerStatus?: Reply;
  onCall?: (msg: { action?: string; method?: string; params?: unknown }) => void;
}) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string; method?: string; params?: unknown } | undefined, cb?: (r: unknown) => void) => {
      routes.onCall?.(msg ?? {});
      let reply: Reply = { success: true };
      if (msg?.action === 'getControlStatus') reply = routes.control ?? { mode: 'install', localNode: false };
      else if (msg?.action === 'controlAuthed' && msg?.method === 'control.peerStatus') reply = routes.peerStatus ?? {};
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

const NODE_UP = { mode: 'manage', localNode: true, base: 'http://dig.local', status: {}, authRequired: false };

describe('PeersTab (#393)', () => {
  beforeEach(() => {
    mockSw({});
  });

  it('shows the node-down state (install CTA) when no local dig-node is reachable', async () => {
    mockSw({ control: { mode: 'install', localNode: false } });
    renderWithProviders(<PeersTab />);
    expect(await screen.findByTestId('peers-nodedown')).toBeInTheDocument();
    expect(screen.getByTestId('peers-install')).toBeInTheDocument();
    // No peer list / management surface while the node is down.
    expect(screen.queryByTestId('peers-manage')).toBeNull();
  });

  it('shows summary + a "needs a newer node" note when the node reports only a count', async () => {
    mockSw({ control: NODE_UP, peerStatus: { running: true, connected_peers: 3 } });
    renderWithProviders(<PeersTab />);
    // Summary reflects the count-only status.
    expect(await screen.findByTestId('peers-count')).toHaveTextContent('3');
    // No per-peer array → honest "details need a newer node" note (not fake rows).
    expect(await screen.findByTestId('peers-list-unavailable')).toBeInTheDocument();
    // Management controls are present but disabled (node hasn't advertised support yet) + a note.
    expect(screen.getByTestId('peers-manage-unsupported')).toBeInTheDocument();
    expect(screen.getByTestId('peers-connect-input')).toBeDisabled();
    expect(screen.getByTestId('peers-connect-submit')).toBeDisabled();
    // Pre-launch reality is surfaced as a standing note, not an error.
    expect(screen.getByTestId('peers-prelaunch')).toBeInTheDocument();
  });

  it('renders the peer table + enables management when the node advertises support', async () => {
    mockSw({
      control: NODE_UP,
      peerStatus: {
        running: true,
        connected_peers: 1,
        management_supported: true,
        peers: [
          { peer_id: 'peerA', addresses: ['[2001:db8::1]:8444'], connection_type: 'direct', direction: 'outbound', latency_ms: 42 },
        ],
        bans: [],
      },
    });
    renderWithProviders(<PeersTab />);
    const table = await screen.findByTestId('peers-table');
    expect(table).toBeInTheDocument();
    expect(screen.getByTestId('peer-row')).toHaveAttribute('data-peer', 'peerA');
    // IPv6-first address is shown (§5.2).
    expect(table).toHaveTextContent('2001:db8::1');
    // Management enabled — connect form usable.
    expect(screen.getByTestId('peers-connect-input')).toBeEnabled();
  });

  it('drives control.peers.connect when connecting to a peer (management enabled)', async () => {
    const calls: { action?: string; method?: string; params?: unknown }[] = [];
    mockSw({
      control: NODE_UP,
      peerStatus: { running: true, connected_peers: 0, management_supported: true, peers: [], bans: [] },
      onCall: (m) => calls.push(m),
    });
    renderWithProviders(<PeersTab />);
    const input = await screen.findByTestId('peers-connect-input');
    await userEvent.type(input, 'peerXYZ');
    await userEvent.click(screen.getByTestId('peers-connect-submit'));
    await waitFor(() =>
      expect(calls.some((c) => c.action === 'controlAuthed' && c.method === 'control.peers.connect')).toBe(true),
    );
  });
});
