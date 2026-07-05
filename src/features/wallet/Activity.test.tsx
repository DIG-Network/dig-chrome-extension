import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Activity } from '@/features/wallet/Activity';
import { renderWithProviders, makeTransport } from '@/test/harness';

describe('Activity', () => {
  it('renders an empty state when there are no transactions', async () => {
    const transport = makeTransport({ isConnected: vi.fn(async () => true), request: vi.fn(async () => ({ transactions: [] })) });
    renderWithProviders(<Activity />, { transport });
    expect(await screen.findByTestId('activity-empty')).toBeInTheDocument();
  });

  it('renders human-readable rows with a status pill', async () => {
    const transport = makeTransport({
      isConnected: vi.fn(async () => true),
      request: vi.fn(async () => ({
        transactions: [{ amount: 5_000_000_000_000, type: 'outgoing', confirmed: true, name: 'coin1', fee: 1_000_000 }],
      })),
    });
    renderWithProviders(<Activity />, { transport });
    expect(await screen.findByTestId('activity-item')).toBeInTheDocument();
  });
});
