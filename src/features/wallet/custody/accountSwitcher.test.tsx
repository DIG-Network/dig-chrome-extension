import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { AccountSwitcher } from '@/features/wallet/custody/AccountSwitcher';
import type { AccountEntry } from '@/lib/wallet-registry';

/**
 * Component tests for the named-account switcher (#95). Accounts + the active index live behind the
 * SW seam, so a STATEFUL `chrome.runtime.sendMessage` mock models one wallet's accounts + its active
 * index. Switching an account calls `setActiveIndex` with the account's index (the #165 model — an
 * account is only a friendly bookmark over a single index, never a second scan dimension).
 */

function mockRegistry(init: { accounts: AccountEntry[]; activeIndex: number }) {
  let accounts = init.accounts.map((a) => ({ ...a }));
  let activeIndex = init.activeIndex;
  const wallet = () => ({ id: 'w1', label: 'Main', createdAt: 1, active: true, activeIndex, accounts });
  const router = (m: { action: string; [k: string]: unknown }) => {
    switch (m.action) {
      case 'getLockState':
        return { lockState: 'unlocked', activeWalletId: 'w1', activeIndex };
      case 'listWallets':
        return { wallets: [wallet()], activeWalletId: 'w1' };
      case 'setActiveIndex':
        activeIndex = m.index as number;
        return { success: true, activeIndex };
      case 'addAccount': {
        const nextIndex = Math.max(...accounts.map((a) => a.index)) + 1;
        accounts = [...accounts, { id: `acct-${nextIndex}`, label: (m.label as string) || `Account ${accounts.length + 1}`, index: nextIndex }];
        return { success: true, accounts };
      }
      case 'renameAccount':
        accounts = accounts.map((a) => (a.id === m.accountId ? { ...a, label: m.label as string } : a));
        return { success: true, accounts };
      case 'removeAccount': {
        if (accounts.length <= 1) return { success: false, code: 'LAST_ACCOUNT', message: 'last' };
        const removed = accounts.find((a) => a.id === m.accountId);
        accounts = accounts.filter((a) => a.id !== m.accountId);
        if (removed && removed.index === activeIndex) activeIndex = accounts[0].index;
        return { success: true, accounts };
      }
      default:
        return { success: true };
    }
  };
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

const TWO_ACCOUNTS: AccountEntry[] = [
  { id: 'a0', label: 'Main', index: 0 },
  { id: 'a1', label: 'Savings', index: 5 },
];

describe('AccountSwitcher (#95)', () => {
  it('shows the active account label on the pill', async () => {
    mockRegistry({ accounts: TWO_ACCOUNTS, activeIndex: 5 });
    renderWithProviders(<AccountSwitcher />);
    await waitFor(() => expect(screen.getByTestId('account-switcher-active')).toHaveTextContent('Savings'));
  });

  it('opens the manager sheet and lists every account with its index', async () => {
    mockRegistry({ accounts: TWO_ACCOUNTS, activeIndex: 0 });
    renderWithProviders(<AccountSwitcher />);
    await screen.findByTestId('account-switcher-toggle');
    fireEvent.click(screen.getByTestId('account-switcher-toggle'));
    await screen.findByTestId('account-list');
    expect(screen.getByTestId('account-row-a0')).toBeInTheDocument();
    expect(screen.getByTestId('account-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('account-index-a1')).toHaveTextContent('5');
    // The active account (index 0 → a0) carries the Active badge.
    expect(screen.getByTestId('account-active-a0')).toBeInTheDocument();
  });

  it('switching an account calls setActiveIndex with THAT account\'s index (#165, not a new scan)', async () => {
    const send = mockRegistry({ accounts: TWO_ACCOUNTS, activeIndex: 0 });
    renderWithProviders(<AccountSwitcher />);
    await screen.findByTestId('account-switcher-toggle');
    fireEvent.click(screen.getByTestId('account-switcher-toggle'));
    await screen.findByTestId('account-switch-a1');
    fireEvent.click(screen.getByTestId('account-switch-a1'));
    await waitFor(() => {
      const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'setActiveIndex');
      expect(call).toBeTruthy();
      expect((call![0] as { index: number }).index).toBe(5);
    });
  });

  it('adds a new account via the add form', async () => {
    const send = mockRegistry({ accounts: [{ id: 'a0', label: 'Main', index: 0 }], activeIndex: 0 });
    renderWithProviders(<AccountSwitcher />);
    await screen.findByTestId('account-switcher-toggle');
    fireEvent.click(screen.getByTestId('account-switcher-toggle'));
    await screen.findByTestId('account-add-input');
    fireEvent.change(screen.getByTestId('account-add-input'), { target: { value: 'Trading' } });
    fireEvent.click(screen.getByTestId('account-add-submit'));
    await waitFor(() => {
      const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'addAccount');
      expect(call).toBeTruthy();
      expect((call![0] as { label?: string }).label).toBe('Trading');
    });
  });

  it('renames an account inline', async () => {
    const send = mockRegistry({ accounts: TWO_ACCOUNTS, activeIndex: 0 });
    renderWithProviders(<AccountSwitcher />);
    await screen.findByTestId('account-switcher-toggle');
    fireEvent.click(screen.getByTestId('account-switcher-toggle'));
    await screen.findByTestId('account-rename-a1');
    fireEvent.click(screen.getByTestId('account-rename-a1'));
    fireEvent.change(screen.getByTestId('account-rename-input-a1'), { target: { value: 'Vault' } });
    fireEvent.click(screen.getByTestId('account-rename-save-a1'));
    await waitFor(() => {
      const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'renameAccount');
      expect((call![0] as { label: string }).label).toBe('Vault');
    });
  });

  it('removes a non-last account after the two-step confirm', async () => {
    const send = mockRegistry({ accounts: TWO_ACCOUNTS, activeIndex: 0 });
    renderWithProviders(<AccountSwitcher />);
    await screen.findByTestId('account-switcher-toggle');
    fireEvent.click(screen.getByTestId('account-switcher-toggle'));
    await screen.findByTestId('account-remove-a1');
    fireEvent.click(screen.getByTestId('account-remove-a1'));
    await screen.findByTestId('account-remove-yes-a1');
    fireEvent.click(screen.getByTestId('account-remove-yes-a1'));
    await waitFor(() => {
      const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'removeAccount');
      expect((call![0] as { accountId: string }).accountId).toBe('a1');
    });
  });

  it('does not render at all when there is no wallet', async () => {
    // No active wallet → the switcher renders nothing (the wallet gate handles the no-wallet state).
    const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
      const m = msg as { action: string };
      const reply = m.action === 'listWallets' ? { wallets: [], activeWalletId: null } : { lockState: 'none' };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    });
    (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
    const { container } = renderWithProviders(<AccountSwitcher />);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="account-switcher"]')).toBeNull();
  });
});
