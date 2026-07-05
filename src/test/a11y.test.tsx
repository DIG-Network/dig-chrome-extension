import { describe, it, expect } from 'vitest';
import { axe } from 'jest-axe';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { ConnectPanel } from '@/features/wallet/ConnectPanel';
import { AppsTab } from '@/features/apps/AppsTab';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { RecoveryReveal } from '@/features/wallet/custody/RecoveryReveal';
import { renderWithProviders } from '@/test/harness';

// color-contrast needs real layout (jsdom can't compute it); assert on structure/roles/labels.
const AXE_OPTS = { rules: { 'color-contrast': { enabled: false } } };

describe('accessibility (axe)', () => {
  it('ResolverTab has no WCAG violations', async () => {
    const { container } = renderWithProviders(<ResolverTab />);
    const results = await axe(container, AXE_OPTS);
    expect(results.violations).toEqual([]);
  });

  it('ConnectPanel has no WCAG violations', async () => {
    const { container } = renderWithProviders(<ConnectPanel />);
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
});
