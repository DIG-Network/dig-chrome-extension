import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeersTab } from '@/features/peers/PeersTab';
import { renderWithProviders } from '@/test/harness';
import { initialPairingState, type PairingState } from '@/lib/dig-pairing';

type Reply = unknown;

/** A `paired` pairing state — the precondition for reading the token-gated `control.peerStatus`. */
const PAIRED: PairingState = { ...initialPairingState(), phase: 'paired' };
/** An `unpaired` pairing state — the node is reachable but the extension holds no control token. */
const UNPAIRED: PairingState = initialPairingState();

/**
 * Route sendMessage by action + control method so each test declares its node responses. Peers is a
 * TOKEN-GATED surface: `control.peerStatus` only answers once the extension is paired, so a test
 * that expects peer content must also declare a `pairing: PAIRED` state (mirrors the SW gate).
 */
function mockSw(routes: {
  control?: Reply;
  peerStatus?: Reply;
  pairing?: PairingState;
  onCall?: (msg: { action?: string; method?: string; params?: unknown }) => void;
}) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string; method?: string; params?: unknown } | undefined, cb?: (r: unknown) => void) => {
      routes.onCall?.(msg ?? {});
      let reply: Reply = { success: true };
      if (msg?.action === 'getControlStatus') reply = routes.control ?? { mode: 'install', localNode: false };
      else if (msg?.action === 'pairingState') reply = routes.pairing ?? UNPAIRED;
      else if (msg?.action === 'controlAuthed' && msg?.method === 'control.peerStatus') reply = routes.peerStatus ?? {};
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

const NODE_UP = { mode: 'manage', localNode: true, base: 'http://dig.local', status: {}, authRequired: false };

/** The SW's reply when a token-gated `control.*` call is made with no paired token (#281). */
const NOT_PAIRED_ERROR = { success: false, error: 'not paired', code: -32030 };

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

  // Regression (super-repo #560): the node is RUNNING but the extension is NOT paired. `control.peerStatus`
  // is token-gated, so firing it unpaired returns -32030 ("not paired"). The tab must offer the PAIRING
  // affordance (the forward path), NOT surface a dead "couldn't load peers / try again" error that leaves
  // the user trapped — pairing, not retry, is the real precondition for reading peers.
  it('offers the pairing affordance (not a dead "try again" error) when the node is online but not paired', async () => {
    mockSw({ control: NODE_UP, pairing: UNPAIRED, peerStatus: NOT_PAIRED_ERROR });
    renderWithProviders(<PeersTab />);
    // The pairing CTA is the way forward.
    expect(await screen.findByTestId('control-pairing-start')).toBeInTheDocument();
    // The token-gated peer content (and its dead "try again" error) is NOT rendered while unpaired.
    expect(screen.queryByTestId('peers-list-error')).toBeNull();
    expect(screen.queryByTestId('peers-status')).toBeNull();
  });

  it('shows summary + a "needs a newer node" note when the node reports only a count', async () => {
    mockSw({ control: NODE_UP, pairing: PAIRED, peerStatus: { running: true, connected_peers: 3 } });
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
      pairing: PAIRED,
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
      pairing: PAIRED,
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
