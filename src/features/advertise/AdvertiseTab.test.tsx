import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AdvertiseTab } from '@/features/advertise/AdvertiseTab';
import { renderWithProviders } from '@/test/harness';

describe('AdvertiseTab (#411)', () => {
  it('renders a labelled Advertise region with a centered "Coming soon" placeholder', () => {
    renderWithProviders(<AdvertiseTab />);
    const region = screen.getByTestId('advertise-panel');
    expect(region).toBeInTheDocument();
    // Labelled landmark (accessible + agent-drivable).
    expect(region).toHaveAttribute('aria-labelledby', 'advertise-title');
    expect(screen.getByRole('heading', { name: /advertise/i })).toBeInTheDocument();
    // The placeholder is present with the "Coming soon" copy (no real advertise UI yet).
    const soon = screen.getByTestId('advertise-comingsoon');
    expect(soon).toHaveTextContent(/coming soon/i);
  });
});
