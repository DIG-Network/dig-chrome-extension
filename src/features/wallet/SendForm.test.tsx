import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SendForm } from '@/features/wallet/SendForm';
import { createStore } from '@/app/store';
import { renderWithProviders, makeTransport } from '@/test/harness';
import type { AssetBalance } from '@/features/wallet/walletApi';

const assets: AssetBalance[] = [
  {
    descriptor: { key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, assetId: null, type: null },
    balance: 5_000_000_000_000,
    label: '5',
  },
];

describe('SendForm', () => {
  it('shows validation errors for a bad address + amount', async () => {
    renderWithProviders(<SendForm assets={assets} onDone={() => {}} />);
    await userEvent.click(screen.getByTestId('send-submit'));
    expect(await screen.findByTestId('send-address-error')).toBeInTheDocument();
    expect(screen.getByTestId('send-amount-error')).toBeInTheDocument();
  });

  it('brokers a chia_send with converted base units on a valid form', async () => {
    const request = vi.fn(async () => ({ success: true }));
    const transport = makeTransport({ request });
    const store = createStore(transport);
    renderWithProviders(<SendForm assets={assets} onDone={() => {}} />, { transport, store });

    await userEvent.type(screen.getByTestId('send-amount'), '1.5');
    await userEvent.type(screen.getByTestId('send-address'), 'xch1validaddress000000');
    await userEvent.click(screen.getByTestId('send-submit'));

    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith('chia_send', expect.objectContaining({ amount: 1_500_000_000_000 }));
  });
});
