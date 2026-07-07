import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { NoWalletCard } from '@/features/wallet/custody/NoWalletCard';
import { AppsTab } from '@/features/apps/AppsTab';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { RecoveryReveal } from '@/features/wallet/custody/RecoveryReveal';
import { HomeScreen } from '@/features/home/HomeScreen';
import { renderWithProviders } from '@/test/harness';

// color-contrast needs real layout (jsdom can't compute it); assert on structure/roles/labels.
const AXE_OPTS = { rules: { 'color-contrast': { enabled: false } } };

describe('accessibility (axe)', () => {
  it('ResolverTab has no WCAG violations', async () => {
    const { container } = renderWithProviders(<ResolverTab />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('NoWalletCard has no WCAG violations', async () => {
    const { container } = renderWithProviders(<NoWalletCard />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('AppsTab has no WCAG violations', async () => {
    const { container } = renderWithProviders(<AppsTab />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('UnlockScreen has no WCAG violations', async () => {
    const { container } = renderWithProviders(<UnlockScreen />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('RecoveryReveal (revealed) has no WCAG violations', async () => {
    const { container } = renderWithProviders(
      <RecoveryReveal mnemonic={Array(24).fill('alpha').join(' ')} />,
    );
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('HomeScreen (no wallet) has no WCAG violations', async () => {
    const { container } = renderWithProviders(<HomeScreen />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('HomeScreen with the balance-unit swap control (#156, unlocked) has no WCAG violations', async () => {
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
      (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
        let reply: unknown = { success: true };
        if (msg?.action === 'getLockState') reply = { lockState: 'unlocked' };
        else if (msg?.action === 'getCustodyBalances') reply = { balances: { xch: 2_510_000_000_000, cats: {} } };
        else if (msg?.action === 'getActivity') reply = { events: [] };
        if (cb) cb(reply);
        return Promise.resolve(reply);
      },
    );
    const { container, findByTestId } = renderWithProviders(<HomeScreen />);
    await findByTestId('home-balance-swap');
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });
});
