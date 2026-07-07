import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
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

  it('AppsTab in personalization edit mode (drag/keyboard-reorder + hide controls, #164) has no WCAG violations', async () => {
    (chrome.storage as unknown as { local: unknown }).local = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          apps: [
            { slug: 'a', name: 'App A', icon: 'https://explore.dig.net/a.png', link: 'https://a.on.dig.net/', category: 'tools', featured: false },
            { slug: 'b', name: 'App B', icon: 'https://explore.dig.net/b.png', link: 'https://b.on.dig.net/', category: 'tools', featured: false },
          ],
        }),
      })),
    );
    const { container } = renderWithProviders(<AppsTab />);
    await screen.findByTestId('apps-launcher');
    fireEvent.click(screen.getByTestId('apps-edit-toggle'));
    fireEvent.click(screen.getByTestId('app-hide-b'));
    fireEvent.click(screen.getByTestId('apps-hidden-toggle')); // expand "Show hidden (1)"
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
