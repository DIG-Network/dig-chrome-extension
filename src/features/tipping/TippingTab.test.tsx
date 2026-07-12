import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TippingTab } from '@/features/tipping/TippingTab';

/** Node online (manage mode) + empty ledger + no wallet address — enough to render all three sections. */
function mockSw({ nodeOnline = true }: { nodeOnline?: boolean } = {}) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string; method?: string } | undefined, cb?: (r: unknown) => void) => {
      let reply: unknown = { success: false };
      if (msg?.action === 'getControlStatus') {
        reply = nodeOnline
          ? { mode: 'manage', localNode: true, base: 'http://dig.local', controlEndpoint: 'http://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] }
          : { mode: 'install', localNode: false, base: null, controlEndpoint: null, readFallback: 'https://rpc.dig.net', status: null, authRequired: false, controlMethods: [] };
      } else if (msg?.action === 'pairingState') reply = { phase: 'unpaired' };
      else if (msg?.method === 'tip.get_ledger') reply = [];
      else if (msg?.method === 'tip.get_config')
        reply = { creator: {}, dev: {}, daily_total_cap: 0, fee: 0 };
      else if (msg?.action === 'getReceiveAddress') reply = { address: '' };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('TippingTab', () => {
  it('renders the three sections + the #428 activation note', async () => {
    mockSw({ nodeOnline: true });
    renderWithProviders(<TippingTab />);
    await waitFor(() => expect(screen.getByTestId('tipping-panel')).toBeTruthy());
    expect(screen.getByTestId('tipping-activation-note')).toBeTruthy();
    expect(screen.getByTestId('tip-history')).toBeTruthy();
    expect(screen.getByTestId('tip-manage')).toBeTruthy();
    expect(screen.getByTestId('tip-xchtip')).toBeTruthy();
  });

  it('surfaces the node-down state for the node-dependent sections when the node is offline', async () => {
    mockSw({ nodeOnline: false });
    renderWithProviders(<TippingTab />);
    await waitFor(() => expect(screen.getByTestId('tip-history-nodedown')).toBeTruthy());
    expect(screen.getByTestId('tip-manage-nodedown')).toBeTruthy();
    // The xchtip section is node-independent and still renders.
    expect(screen.getByTestId('tip-xchtip')).toBeTruthy();
  });
});
