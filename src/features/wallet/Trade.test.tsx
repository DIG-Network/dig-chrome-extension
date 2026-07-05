import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trade } from '@/features/wallet/Trade';
import { createStore } from '@/app/store';
import { renderWithProviders, makeTransport } from '@/test/harness';
import type { AssetBalance } from '@/features/wallet/walletApi';

const assets: AssetBalance[] = [
  { descriptor: { key: 'xch', ticker: 'XCH', name: 'Chia', decimals: 12, assetId: null, type: null }, balance: 5e12, label: '5' },
  { descriptor: { key: 'dig', ticker: '$DIG', name: 'DIG', decimals: 3, assetId: 'aa', type: 'cat' }, balance: 1000, label: '1' },
];

describe('Trade', () => {
  it('validates an empty make-offer form', async () => {
    renderWithProviders(<Trade assets={assets} />);
    await userEvent.click(screen.getByTestId('offer-make-submit'));
    expect(await screen.findByTestId('offer-make-error')).toBeInTheDocument();
  });

  it('brokers a create offer when both legs are filled', async () => {
    const request = vi.fn(async () => ({ offer: 'offer1abc' }));
    const transport = makeTransport({ request });
    const store = createStore(transport);
    renderWithProviders(<Trade assets={assets} />, { transport, store });
    await userEvent.type(screen.getByTestId('offer-give-amount'), '1');
    await userEvent.type(screen.getByTestId('offer-get-amount'), '10');
    await userEvent.click(screen.getByTestId('offer-make-submit'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('chia_createOffer', expect.any(Object)));
  });

  it('rejects a bad take-offer string and brokers a valid one', async () => {
    const request = vi.fn(async () => ({ success: true }));
    const transport = makeTransport({ request });
    const store = createStore(transport);
    renderWithProviders(<Trade assets={assets} />, { transport, store });
    await userEvent.type(screen.getByTestId('offer-take-string'), 'not-an-offer');
    await userEvent.click(screen.getByTestId('offer-take-submit'));
    expect(await screen.findByTestId('offer-take-error')).toBeInTheDocument();

    await userEvent.clear(screen.getByTestId('offer-take-string'));
    await userEvent.type(screen.getByTestId('offer-take-string'), 'offer1validstring');
    await userEvent.click(screen.getByTestId('offer-take-submit'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('chia_takeOffer', { offer: 'offer1validstring' }));
  });
});
