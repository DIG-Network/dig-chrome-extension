import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { PortfolioHero } from '@/features/wallet/PortfolioHero';
import { renderWithProviders } from '@/test/harness';
import type { PortfolioValue } from '@/features/wallet/portfolioValue';
import type { HeroBalance } from '@/features/wallet/portfolio';

const hero: HeroBalance = { asset: null, amountLabel: '2', ticker: 'XCH' };

function renderHero(total: PortfolioValue, extra: Partial<React.ComponentProps<typeof PortfolioHero>> = {}) {
  return renderWithProviders(
    <PortfolioHero total={total} hero={hero} pricesLoading={false} pricesError={false} fiat="usd" fxRates={undefined} fxLoading={false} {...extra} />,
  );
}

describe('PortfolioHero', () => {
  it('shows the USD total by default (fiat = usd, no fx lookup needed)', () => {
    renderHero({ totalUsd: 25, change24hUsd: null, change24hPct: null });
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$25.00');
  });

  it('falls back to the native amount + status line when there is no priced total (fiat-agnostic)', () => {
    renderHero({ totalUsd: null, change24hUsd: null, change24hPct: null });
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('2');
    expect(screen.getByTestId('portfolio-status')).toBeInTheDocument();
  });

  it('renders the total converted to a non-USD currency when the rate is known', () => {
    renderHero({ totalUsd: 10, change24hUsd: null, change24hPct: null }, { fiat: 'eur', fxRates: { eur: 0.9 } });
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('€9.00');
  });

  it('shows a loading indicator (never a value or "unavailable") while the fx rate is still loading', () => {
    renderHero({ totalUsd: 10, change24hUsd: null, change24hPct: null }, { fiat: 'eur', fxRates: undefined, fxLoading: true });
    expect(screen.getByTestId('portfolio-value-loading')).toBeInTheDocument();
    expect(screen.getByTestId('portfolio-value')).not.toHaveTextContent(/unavailable/i);
  });

  it('gracefully degrades to USD when the fx rate settled with nothing usable', () => {
    renderHero({ totalUsd: 10, change24hUsd: null, change24hPct: null }, { fiat: 'eur', fxRates: {}, fxLoading: false });
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('$10.00');
  });

  it('converts the 24h change amount to the same chosen currency as the total', () => {
    renderHero({ totalUsd: 10, change24hUsd: 2, change24hPct: 25 }, { fiat: 'eur', fxRates: { eur: 0.5 } });
    expect(screen.getByTestId('portfolio-value')).toHaveTextContent('€5.00');
    expect(screen.getByTestId('portfolio-change')).toHaveTextContent('€1.00'); // 2 usd × 0.5
  });

  it('shows the retry action on a genuine price error', () => {
    const onRetry = vi.fn();
    renderHero({ totalUsd: null, change24hUsd: null, change24hPct: null }, { pricesError: true, onRetry });
    expect(screen.getByTestId('portfolio-retry')).toBeInTheDocument();
  });
});
