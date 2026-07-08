import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { setWalletView, setAdvanced } from '@/features/ui/uiSlice';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { PrivacyNote } from '@/features/wallet/custody/PrivacyNote';
import { ChainNodeSetting } from '@/features/wallet/custody/ChainNodeSetting';
import { AutoLockSetting } from '@/features/wallet/custody/AutoLockSetting';
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
  it('renders the scanned portfolio + assets', async () => {
    mockSw((m) => {
      if (m.action === 'getCustodyBalances') return { balances: { xch: 2_510_000_000_000, cats: {} } };
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      return { success: true };
    });
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('2.51'));
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
  });

  /**
   * #166 — Receive is its own screen (opened via the "Receive" action), not embedded below the
   * asset list: the QR/address must never be pushed down by a growable CAT list. Clicking Receive
   * replaces the whole Home body with the Receive screen (sticky header + QR/address only, no
   * asset list beside it); the header's back action returns to Assets.
   */
  it('opens a dedicated Receive screen from the assets action bar, with a working back action', async () => {
    mockSw((m) => {
      if (m.action === 'getCustodyBalances') return { balances: { xch: 2_510_000_000_000, cats: {} } };
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      return { success: true };
    });
    renderWithProviders(<CustodyWallet />);
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
    expect(screen.queryByTestId('wallet-receive-screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('action-receive'));
    expect((await screen.findByTestId('wallet-address')).getAttribute('value')).toBe('xch1receive');
    // The Receive screen is the ENTIRE body — no asset list sits beside/above it, so it's reachable
    // with zero scrolling no matter how many CATs the wallet holds.
    expect(screen.queryByTestId('custody-assets')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('receive-close'));
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();
    expect(screen.queryByTestId('wallet-receive-screen')).not.toBeInTheDocument();
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
      if (m.action === 'getActivity') return { events: [] };
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

  it('hides the chain-node, auto-lock, and derived-address settings by default (everyday tier)', async () => {
    mockSw((m) => (m.action === 'getReceiveAddress' ? { address: 'xch1receive' } : { balances: { xch: 0, cats: {} } }));
    renderWithProviders(<CustodyWallet />);
    await screen.findByTestId('custody-wallet');
    expect(screen.queryByTestId('chain-node-setting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-lock-setting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('derived-addresses')).not.toBeInTheDocument();
  });

  it('shows the chain-node, auto-lock, and derived-address list in advanced mode (#106)', async () => {
    mockSw((m) => {
      if (m.action === 'getReceiveAddress') return { address: 'xch1receive' };
      if (m.action === 'listDerivedAddresses') return { addresses: [{ index: 0, scheme: 'unhardened', address: 'xch1derived' }] };
      return { balances: { xch: 0, cats: {} } };
    });
    const store = createStore();
    store.dispatch(setAdvanced(true));
    renderWithProviders(<CustodyWallet />, { store });
    expect(await screen.findByTestId('chain-node-setting')).toBeInTheDocument();
    expect(await screen.findByTestId('auto-lock-setting')).toBeInTheDocument();
    expect(await screen.findByTestId('derived-addresses')).toBeInTheDocument();
    expect(await screen.findByTestId('derived-address-unhardened-0')).toBeInTheDocument();
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

describe('AutoLockSetting (#155)', () => {
  it('loads the default TTL when unset, and saves a custom idle timeout', async () => {
    renderWithProviders(<AutoLockSetting />);
    expect(await screen.findByTestId('auto-lock-input')).toHaveValue(15);
    fireEvent.change(screen.getByTestId('auto-lock-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('auto-lock-save'));
    await waitFor(async () => expect((await readWalletSettings()).unlockTtlMinutes).toBe(30));
  });

  it('clamps an out-of-range value into [1,60] instead of persisting it verbatim', async () => {
    renderWithProviders(<AutoLockSetting />);
    await screen.findByTestId('auto-lock-input');
    fireEvent.change(screen.getByTestId('auto-lock-input'), { target: { value: '9999' } });
    fireEvent.click(screen.getByTestId('auto-lock-save'));
    await waitFor(async () => expect((await readWalletSettings()).unlockTtlMinutes).toBe(60));
    expect(screen.getByTestId('auto-lock-input')).toHaveValue(60);
  });
});
