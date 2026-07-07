import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { WalletManagerList } from '@/features/wallet/custody/WalletManagerList';
import type { WalletMeta } from '@/lib/wallet-registry';

/**
 * Focused unit coverage for the NEW behavior #176 adds to the wallet list (address preview +
 * identicon + roving keyboard nav). The row switch/rename/remove/lock mutation flows this
 * component inherited from the old inline `WalletRow` are already covered end-to-end through the
 * real tree in `walletSwitcher.test.tsx` (unchanged by the extraction) — this file does not
 * duplicate that coverage.
 */

function mockRegistry() {
  const fn = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
    const reply = { success: true };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

afterEach(() => vi.restoreAllMocks());

const WALLETS: WalletMeta[] = [
  { id: 'w1', label: 'Main', createdAt: 1, active: true, activeIndex: 0, previewAddress: 'xch1' + 'a'.repeat(58) },
  { id: 'w2', label: 'Trading', createdAt: 2, active: false, activeIndex: 0 }, // no previewAddress yet
];

describe('WalletManagerList (#176)', () => {
  it('shows a truncated address preview for a wallet with a cached preview address', async () => {
    mockRegistry();
    renderWithProviders(<WalletManagerList wallets={WALLETS} onDone={() => {}} />);
    const preview = screen.getByTestId('wallet-address-preview-w1');
    expect(preview).toHaveTextContent('xch1');
    expect(preview.textContent).not.toBe('xch1' + 'a'.repeat(58)); // truncated, not the full address
  });

  it('shows a graceful placeholder (never a fabricated address) when none is cached yet', async () => {
    mockRegistry();
    renderWithProviders(<WalletManagerList wallets={WALLETS} onDone={() => {}} />);
    const preview = screen.getByTestId('wallet-address-preview-w2');
    expect(preview).not.toHaveTextContent('xch1');
  });

  it('renders a distinct identicon per row', async () => {
    mockRegistry();
    const { container } = renderWithProviders(<WalletManagerList wallets={WALLETS} onDone={() => {}} />);
    const svgs = container.querySelectorAll('svg.dig-identicon');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].innerHTML).not.toBe(svgs[1].innerHTML);
  });

  it('ArrowDown/ArrowUp roves focus between the switch buttons', async () => {
    mockRegistry();
    renderWithProviders(<WalletManagerList wallets={WALLETS} onDone={() => {}} />);
    const list = screen.getByTestId('wallet-list');
    const first = screen.getByTestId('wallet-switch-w1');
    const second = screen.getByTestId('wallet-switch-w2');
    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(second));

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(first)); // wraps around

    fireEvent.keyDown(list, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(second)); // wraps the other way
  });
});
