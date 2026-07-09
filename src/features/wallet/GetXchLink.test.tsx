import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { GetXchLink } from '@/features/wallet/GetXchLink';
import { renderWithProviders } from '@/test/harness';
import { GET_XCH_URL } from '@/lib/links';

/**
 * #210 — the "Get more XCH" affordance rendered next to the XCH asset row: unlike the $DIG row's
 * multi-venue {@link GetDigMenu} (#202), XCH has ONE canonical acquisition destination
 * (chia.net/buy-xch), so this is a plain outbound link — no popover/menu.
 */
describe('GetXchLink', () => {
  it('renders a single link to the canonical chia.net buy-XCH page, opening in a new tab', () => {
    renderWithProviders(<GetXchLink />);
    const link = screen.getByTestId('getxch-link');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', GET_XCH_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders no menu/popover — a plain link, not a disclosure trigger', () => {
    renderWithProviders(<GetXchLink />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('getxch-link')).not.toHaveAttribute('aria-haspopup');
  });
});
