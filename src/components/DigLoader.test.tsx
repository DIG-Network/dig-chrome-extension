import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DigLoader } from '@/components/DigLoader';

describe('DigLoader (on.dig.net-matching branded loading card, #157)', () => {
  it('renders the DIG mark, spinner, title and subtitle inside a status region', () => {
    render(<DigLoader title="Opening Chia-Offer…" subtitle="Connecting securely" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('data-state', 'loading');
    expect(within(region).getByRole('img', { name: 'DIG Network' })).toBeInTheDocument();
    expect(within(region).getByText('Opening Chia-Offer…')).toBeInTheDocument();
    expect(within(region).getByText('Connecting securely')).toBeInTheDocument();
  });

  it('omits the subtitle line when none is given', () => {
    render(<DigLoader title="Loading…" />);
    // Only the title paragraph should render — no empty subtitle node left behind.
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(document.querySelector('.dig-loader-subtitle')).not.toBeInTheDocument();
  });

  it('exposes the given data-testid on the status region for e2e/agent hooks', () => {
    render(<DigLoader title="Loading…" testid="appview-loading" />);
    expect(screen.getByTestId('appview-loading')).toBe(screen.getByRole('status'));
  });
});
