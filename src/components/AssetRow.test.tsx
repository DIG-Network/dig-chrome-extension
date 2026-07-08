import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { AssetRow } from '@/components/AssetRow';
import { renderWithProviders } from '@/test/harness';

describe('AssetRow', () => {
  it('renders a monogram badge when there is no icon', () => {
    const { container } = renderWithProviders(<AssetRow ticker="$DIG" name="DIG" amountLabel="1.5" fiatLabel="≈ $3.00" testid="asset-dig" />);
    expect(screen.getByTestId('asset-dig')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-dig-icon')).toBeNull();
    expect(container.querySelector('.dig-asset-badge')?.textContent).toBe('DIG'); // monogram (sigil stripped)
  });

  it('renders the registry icon when a URL is supplied', () => {
    renderWithProviders(
      <AssetRow ticker="GMA" name="Gamma" amountLabel="10" fiatLabel={null} iconUrl="https://icons.dexie.space/gamma.webp" testid="asset-gma" />,
    );
    const icon = screen.getByTestId('asset-gma-icon') as HTMLImageElement;
    expect(icon.tagName).toBe('IMG');
    expect(icon.src).toBe('https://icons.dexie.space/gamma.webp');
  });

  it('falls back to the monogram when the icon fails to load', () => {
    const { container } = renderWithProviders(
      <AssetRow ticker="GMA" name="Gamma" amountLabel="10" fiatLabel={null} iconUrl="https://icons.dexie.space/gamma.webp" testid="asset-gma" />,
    );
    fireEvent.error(screen.getByTestId('asset-gma-icon'));
    expect(screen.queryByTestId('asset-gma-icon')).toBeNull();
    expect(container.querySelector('.dig-asset-badge')?.textContent).toBe('GMA');
  });

  it('shows a loading fiat placeholder while prices load', () => {
    renderWithProviders(<AssetRow ticker="XCH" name="Chia" amountLabel="1" fiatLabel={null} priceLoading testid="asset-xch" />);
    expect(screen.getByTestId('asset-xch-fiat-loading')).toBeInTheDocument();
  });

  it('renders an optional action slot next to the ticker (e.g. the $DIG "Get more" menu, #202)', () => {
    renderWithProviders(
      <AssetRow ticker="$DIG" name="DIG" amountLabel="1.5" fiatLabel="≈ $3.00" testid="asset-dig" action={<button data-testid="row-action">act</button>} />,
    );
    expect(screen.getByTestId('row-action')).toBeInTheDocument();
  });

  it('omits the action slot when none is supplied', () => {
    renderWithProviders(<AssetRow ticker="XCH" name="Chia" amountLabel="1" fiatLabel={null} testid="asset-xch" />);
    expect(screen.queryByTestId('row-action')).not.toBeInTheDocument();
  });
});
