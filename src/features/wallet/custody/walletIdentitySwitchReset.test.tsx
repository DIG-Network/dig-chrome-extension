import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyGate } from '@/features/wallet/custody/CustodyGate';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';

/**
 * Route SW messages by action; a router may return a value OR a Promise of one — the mock defers
 * the `sendMessage` callback until it resolves, so a test can model a real network round-trip delay
 * for exactly the call it cares about (here: wallet B's post-switch balances read).
 */
function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const result = router(msg as { action: string; [k: string]: unknown });
    void Promise.resolve(result).then((reply) => cb?.(reply));
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

/**
 * End-to-end (component-level) regression for #162: switching the active wallet through the REAL
 * `CustodyGate` → `CustodyWallet` → `WalletSwitcher` tree must clear the previous wallet's balance
 * immediately and show the loading state until the newly-active wallet's own balance arrives — never
 * a frame with the old wallet's balance under the new identity, and never a top-level remount (the
 * gate itself must not flicker to its own loading placeholder mid-switch, per the `CustodyGate`
 * `everHydrated` fix).
 */
describe('#162 switching the active wallet resets stale data and shows loading', () => {
  it('clears wallet A balance, shows loading, then renders wallet B balance — no stale/wrong-identity frame', async () => {
    let activeId = 'a';
    let releaseWalletBBalances: (() => void) | undefined;
    const balanceFor = (id: string) => (id === 'a' ? 1_000_000_000_000 : 9_000_000_000_000);

    mockSw((m) => {
      if (m.action === 'getLockState') return { lockState: 'unlocked', activeWalletId: activeId };
      if (m.action === 'listWallets') {
        return {
          wallets: [
            { id: 'a', label: 'Wallet A', createdAt: 1, active: activeId === 'a' },
            { id: 'b', label: 'Wallet B', createdAt: 2, active: activeId === 'b' },
          ],
          activeWalletId: activeId,
        };
      }
      if (m.action === 'switchWallet') {
        activeId = String(m.walletId);
        return { lockState: 'unlocked', activeWalletId: activeId };
      }
      if (m.action === 'getReceiveAddress') return { address: `xch1${activeId}` };
      if (m.action === 'getCustodyBalances') {
        if (activeId === 'b') {
          // Model a real round-trip delay for wallet B's balance so the intermediate
          // "cleared + loading" window is observable instead of resolving instantly.
          return new Promise((resolve) => {
            releaseWalletBBalances = () => resolve({ balances: { xch: balanceFor('b'), cats: {} } });
          });
        }
        return { balances: { xch: balanceFor(activeId), cats: {} } };
      }
      return { success: true };
    });

    renderWithProviders(
      <CustodyGate>
        <CustodyWallet />
      </CustodyGate>,
    );

    // Wallet A's balance renders first.
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('1'));
    expect(screen.getByTestId('wallet-switcher-active')).toHaveTextContent('Wallet A');

    // Switch to wallet B via the real switcher UI.
    fireEvent.click(screen.getByTestId('wallet-switcher-toggle'));
    await screen.findByTestId('wallet-switcher-sheet');
    fireEvent.click(screen.getByTestId('wallet-switch-b'));

    // The instant the switch is confirmed, the balances view must fall back to LOADING — never keep
    // showing wallet A's stale portfolio value (the #162 bug) — and the gate must NOT have remounted
    // (the wallet body, not the top-level custody-gate placeholder, is what's visible).
    await waitFor(() => expect(screen.getByTestId('custody-balances-loading')).toBeInTheDocument());
    expect(screen.queryByText(/^1\.000000000000$/)).not.toBeInTheDocument();
    expect(screen.getByTestId('custody-wallet')).toBeInTheDocument();

    // Resolve the delayed fetch → wallet B's balance appears, and only wallet B's.
    releaseWalletBBalances?.();
    await waitFor(() => expect(screen.getByTestId('portfolio-value')).toHaveTextContent('9'));
    expect(screen.getByTestId('wallet-switcher-active')).toHaveTextContent('Wallet B');
  });
});
