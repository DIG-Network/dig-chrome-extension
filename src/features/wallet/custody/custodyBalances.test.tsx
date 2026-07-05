import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setWalletView, setAdvanced } from '@/features/ui/uiSlice';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { PrivacyNote } from '@/features/wallet/custody/PrivacyNote';
import { ChainNodeSetting } from '@/features/wallet/custody/ChainNodeSetting';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';

function mockSw(router: (m: { action: string }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await chrome.storage.local.remove('wallet.settings');
  await chrome.storage.local.remove('wallet.watchedCats');
});

describe('settings helper', () => {
  it('merges patches without dropping unrelated fields', async () => {
    await updateWalletSettings({ chainRpcUrl: 'https://n1' });
    await updateWalletSettings({ chainPrivacyAck: true });
    const s = await readWalletSettings();
    expect(s).toMatchObject({ chainRpcUrl: 'https://n1', chainPrivacyAck: true });
  });
});

describe('CustodyWallet', () => {
  it('renders the scanned portfolio + assets and the receive address', async () => {
    mockSw((m) => {
      if (m.action === 'getCustodyBalances') return { balances: { xch: 2_510_000_000_000, cats: {} } };
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      return { success: true };
    });
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('2.51'));
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
    expect((await screen.findByTestId('wallet-address')).getAttribute('value')).toBe('xch1receive');
  });

  it('flags a cached snapshot when the scan fell back', async () => {
    mockSw((m) => {
      if (m.action === 'getCustodyBalances') return { balances: { xch: 0, cats: {} }, cached: true };
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      return { success: true };
    });
    renderWithProviders(<CustodyWallet />);
    expect(await screen.findByTestId('balances-cached')).toBeInTheDocument();
  });

  it('renders the activity ledger on the activity sub-view, "coming soon" for trade', async () => {
    mockSw((m) => {
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      if (m.action === 'getActivity') return { events: [], cursorHeight: 0 };
      return { balances: { xch: 0, cats: {} } };
    });
    const store = createStore();
    store.dispatch(setWalletView('activity'));
    renderWithProviders(<CustodyWallet />, { store });
    expect(await screen.findByTestId('custody-activity')).toBeInTheDocument();

    const store2 = createStore();
    store2.dispatch(setWalletView('trade'));
    renderWithProviders(<CustodyWallet />, { store: store2 });
    expect(await screen.findByTestId('custody-trade')).toBeInTheDocument();
  });

  it('hides the chain-node setting by default (everyday tier)', async () => {
    mockSw((m) => (m.action === 'getReceiveAddress' ? { address: 'xch1receive' } : { balances: { xch: 0, cats: {} } }));
    renderWithProviders(<CustodyWallet />);
    await screen.findByTestId('custody-wallet');
    expect(screen.queryByTestId('chain-node-setting')).not.toBeInTheDocument();
  });

  it('shows the chain-node setting in advanced mode', async () => {
    mockSw((m) => (m.action === 'getReceiveAddress' ? { address: 'xch1receive' } : { balances: { xch: 0, cats: {} } }));
    const store = createStore();
    store.dispatch(setAdvanced(true));
    renderWithProviders(<CustodyWallet />, { store });
    expect(await screen.findByTestId('chain-node-setting')).toBeInTheDocument();
  });
});

describe('PrivacyNote', () => {
  it('shows until acknowledged, then hides + persists the ack', async () => {
    mockSw(() => ({ success: true }));
    const { rerender } = renderWithProviders(<PrivacyNote />);
    fireEvent.click(await screen.findByTestId('privacy-ack'));
    await waitFor(async () => expect((await readWalletSettings()).chainPrivacyAck).toBe(true));
    rerender(<PrivacyNote />);
    await waitFor(() => expect(screen.queryByTestId('privacy-note')).not.toBeInTheDocument());
  });
});

describe('ChainNodeSetting', () => {
  it('saves a custom chain node', async () => {
    renderWithProviders(<ChainNodeSetting />);
    fireEvent.change(screen.getByTestId('chain-node-input'), { target: { value: 'https://my.node/rpc' } });
    fireEvent.click(screen.getByTestId('chain-node-save'));
    await waitFor(async () => expect((await readWalletSettings()).chainRpcUrl).toBe('https://my.node/rpc'));
  });
});
