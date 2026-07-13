import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { SecurityTab } from '@/features/security/SecurityTab';

interface Sent {
  action?: string;
  method?: string;
}

const NODE_UP = { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
const NODE_DOWN = { mode: 'install', localNode: false, base: null, controlEndpoint: null, readFallback: 'https://rpc.dig.net', status: null, authRequired: false, controlMethods: [] };
const STATUS = { mode: 'per_transaction', method: 'password', state: 'locked', sign_armed: false, has_wallet: true };

function mockSw({ node, phase }: { node: typeof NODE_UP | typeof NODE_DOWN; phase: string }) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      let r: unknown = { success: true };
      if (m.action === 'getControlStatus') r = node;
      else if (m.action === 'pairingState') r = { phase };
      else if (m.action === 'authRpc' && m.method === 'auth.status') r = STATUS;
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('SecurityTab (#433)', () => {
  it('renders an honest node-down state when no local dig-node is reachable', async () => {
    mockSw({ node: NODE_DOWN, phase: 'unpaired' });
    renderWithProviders(<SecurityTab />);
    expect(await screen.findByTestId('security-nodedown')).toBeTruthy();
    expect(screen.queryByTestId('security-panel')).toBeNull();
  });

  it('renders the three management sections once the node is online + paired', async () => {
    mockSw({ node: NODE_UP, phase: 'paired' });
    renderWithProviders(<SecurityTab />);
    expect(await screen.findByTestId('security-panel')).toBeTruthy();
    expect(screen.getByTestId('security-session')).toBeTruthy();
    expect(screen.getByTestId('security-mode')).toBeTruthy();
    expect(screen.getByTestId('security-method')).toBeTruthy();
  });

  it('keeps the sections behind the pairing gate when the node is online but unpaired', async () => {
    mockSw({ node: NODE_UP, phase: 'unpaired' });
    renderWithProviders(<SecurityTab />);
    expect(await screen.findByTestId('control-pairing')).toBeTruthy();
    expect(screen.queryByTestId('security-panel')).toBeNull();
  });
});
