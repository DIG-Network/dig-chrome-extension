import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FourState } from '@/components/FourState';
import { renderWithProviders } from '@/test/harness';

describe('FourState', () => {
  it('renders the loading state', () => {
    renderWithProviders(
      <FourState isLoading isError={false} isEmpty={false} testid="x">
        <div>content</div>
      </FourState>,
    );
    expect(screen.getByTestId('x-loading')).toBeInTheDocument();
  });

  it('renders the error state with a working retry', async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <FourState isLoading={false} isError isEmpty={false} onRetry={onRetry} testid="x">
        <div>content</div>
      </FourState>,
    );
    await userEvent.click(screen.getByTestId('x-retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders the empty state', () => {
    renderWithProviders(
      <FourState isLoading={false} isError={false} isEmpty testid="x">
        <div>content</div>
      </FourState>,
    );
    expect(screen.getByTestId('x-empty')).toBeInTheDocument();
  });

  it('renders children on success', () => {
    renderWithProviders(
      <FourState isLoading={false} isError={false} isEmpty={false}>
        <div>content</div>
      </FourState>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
