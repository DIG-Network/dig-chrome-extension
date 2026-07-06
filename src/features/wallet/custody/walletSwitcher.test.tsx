import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { WalletSwitcher } from '@/features/wallet/custody/WalletSwitcher';

/**
 * Component tests for the multi-wallet switcher (#90). The registry lives behind the SW seam, so a
 * STATEFUL `chrome.runtime.sendMessage` mock models a mini registry (list / switch / rename / remove
 * / lock) — the real RTK store + tag invalidation drive the refetches, exactly as in the shipped
 * extension. The offscreen vault (keys) is never involved here; the crypto is covered by vault.test.
 */

interface MetaRow {
  id: string;
  label: string;
  createdAt: number;
  active: boolean;
}

function mockRegistry(init: { wallets: MetaRow[]; unlocked?: string[] }) {
  let wallets = init.wallets.map((w) => ({ ...w }));
  let activeId = wallets.find((w) => w.active)?.id ?? wallets[0].id;
  const unlocked = new Set(init.unlocked ?? wallets.map((w) => w.id));
  const setActive = (id: string) => {
    activeId = id;
    wallets = wallets.map((w) => ({ ...w, active: w.id === id }));
  };
  const router = (m: { action: string; [k: string]: unknown }) => {
    switch (m.action) {
      case 'getLockState':
        return { lockState: 'unlocked', activeWalletId: activeId };
      case 'listWallets':
        return { wallets, activeWalletId: activeId };
      case 'switchWallet': {
        const id = m.walletId as string;
        if (unlocked.has(id)) {
          setActive(id);
          return { lockState: 'unlocked', activeWalletId: id };
        }
        if (m.password) {
          if (m.password === 'pw') {
            unlocked.add(id);
            setActive(id);
            return { lockState: 'unlocked', activeWalletId: id };
          }
          return { success: false, code: 'UNLOCK_FAILED', message: 'bad' };
        }
        return { success: false, code: 'NEEDS_UNLOCK', message: 'locked' };
      }
      case 'renameWallet': {
        wallets = wallets.map((w) => (w.id === m.walletId ? { ...w, label: m.label as string } : w));
        return { success: true, wallets, activeWalletId: activeId };
      }
      case 'removeWallet': {
        if (wallets.length <= 1) return { success: false, code: 'LAST_WALLET', message: 'last' };
        const wasActive = m.walletId === activeId;
        wallets = wallets.filter((w) => w.id !== m.walletId);
        if (wasActive) setActive(wallets[0].id);
        return { success: true, wallets, activeWalletId: activeId, lockState: 'unlocked' };
      }
      case 'lockWallet':
        return { lockState: 'locked' };
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

const TWO: MetaRow[] = [
  { id: 'w1', label: 'Main', createdAt: 1, active: true },
  { id: 'w2', label: 'Trading', createdAt: 2, active: false },
];

afterEach(() => vi.restoreAllMocks());

async function openSheet() {
  fireEvent.click(await screen.findByTestId('wallet-switcher-toggle'));
  expect(await screen.findByTestId('wallet-switcher-sheet')).toBeInTheDocument();
}

describe('WalletSwitcher (#90)', () => {
  it('shows the active wallet label and lists every wallet in the manager', async () => {
    mockRegistry({ wallets: TWO });
    renderWithProviders(<WalletSwitcher />);
    expect(await screen.findByTestId('wallet-switcher-active')).toHaveTextContent('Main');
    await openSheet();
    expect(screen.getByTestId('wallet-row-w1')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-row-w2')).toBeInTheDocument();
    // Only the active wallet carries the Active badge.
    expect(screen.getByTestId('wallet-active-w1')).toBeInTheDocument();
    expect(screen.queryByTestId('wallet-active-w2')).not.toBeInTheDocument();
  });

  it('switches to another cached wallet — the active label updates and the sheet closes', async () => {
    mockRegistry({ wallets: TWO, unlocked: ['w1', 'w2'] });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-switch-w2'));
    // Sheet closes on a successful switch, and the pill reflects the new active wallet.
    await waitFor(() => expect(screen.queryByTestId('wallet-switcher-sheet')).not.toBeInTheDocument());
    expect(await screen.findByTestId('wallet-switcher-active')).toHaveTextContent('Trading');
  });

  it('switching to a not-unlocked wallet prompts for its password, then activates it', async () => {
    mockRegistry({ wallets: TWO, unlocked: ['w1'] }); // w2 needs unlock
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-switch-w2'));
    // Inline unlock prompt appears for that row.
    const pw = await screen.findByTestId('wallet-unlock-password-w2');
    fireEvent.change(pw, { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('wallet-unlock-submit-w2'));
    await waitFor(() => expect(screen.queryByTestId('wallet-switcher-sheet')).not.toBeInTheDocument());
    expect(await screen.findByTestId('wallet-switcher-active')).toHaveTextContent('Trading');
  });

  it('renames a wallet inline and shows the new label', async () => {
    mockRegistry({ wallets: TWO });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-rename-w2'));
    const input = await screen.findByTestId('wallet-rename-input-w2');
    fireEvent.change(input, { target: { value: 'Savings' } });
    fireEvent.click(screen.getByTestId('wallet-rename-save-w2'));
    await waitFor(() => expect(screen.getByTestId('wallet-row-w2')).toHaveTextContent('Savings'));
  });

  it('removes a wallet behind a two-step confirm', async () => {
    mockRegistry({ wallets: TWO });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-remove-w2'));
    fireEvent.click(await screen.findByTestId('wallet-remove-yes-w2'));
    // The sheet closes on remove; reopen and confirm w2 is gone.
    await waitFor(() => expect(screen.queryByTestId('wallet-switcher-sheet')).not.toBeInTheDocument());
    await openSheet();
    await waitFor(() => expect(screen.queryByTestId('wallet-row-w2')).not.toBeInTheDocument());
    expect(screen.getByTestId('wallet-row-w1')).toBeInTheDocument();
  });

  it('never offers to remove the only wallet', async () => {
    mockRegistry({ wallets: [{ id: 'w1', label: 'Main', createdAt: 1, active: true }] });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    expect(screen.queryByTestId('wallet-remove-w1')).not.toBeInTheDocument();
  });

  it('locks the wallet from the manager', async () => {
    const sw = mockRegistry({ wallets: TWO });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-lock'));
    await waitFor(() =>
      expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'lockWallet' }), expect.any(Function)),
    );
  });

  it('opens the add-a-wallet flow (onboarding) and returns to the list', async () => {
    mockRegistry({ wallets: TWO });
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    fireEvent.click(screen.getByTestId('wallet-add'));
    expect(await screen.findByTestId('wallet-add-flow')).toBeInTheDocument();
    expect(screen.getByTestId('custody-onboarding')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wallet-add-cancel'));
    expect(await screen.findByTestId('wallet-list')).toBeInTheDocument();
  });

  it('surfaces a list error with a retry affordance', async () => {
    const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
      const m = msg as { action: string };
      const reply = m.action === 'listWallets' ? { success: false, code: 'CUSTODY_ERROR' } : { success: true };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    });
    (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
    renderWithProviders(<WalletSwitcher />);
    await openSheet();
    expect(await screen.findByTestId('wallet-switcher-list-error')).toBeInTheDocument();
  });
});
