import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectPanel } from '@/features/wallet/ConnectPanel';
import { createStore } from '@/app/store';
import { renderWithProviders, makeTransport } from '@/test/harness';

describe('ConnectPanel', () => {
  it('starts pairing on connect and shows the QR', async () => {
    let resolveApproval: (v: { topic: string; address: string }) => void = () => {};
    const connect = vi.fn(async () => ({
      uri: 'wc:pair-uri',
      approval: () => new Promise<{ topic: string; address: string }>((r) => (resolveApproval = r)),
    }));
    const transport = makeTransport({ connect });
    const store = createStore(transport);
    renderWithProviders(<ConnectPanel />, { transport, store });

    await userEvent.click(screen.getByTestId('wallet-connect-cta'));
    expect(connect).toHaveBeenCalled();
    expect(await screen.findByTestId('wallet-connect-qr')).toBeInTheDocument();
    resolveApproval({ topic: 't', address: 'xch1abc' });
    await waitFor(() => expect(screen.queryByTestId('wallet-connect-qr')).not.toBeInTheDocument());
  });

  it('surfaces a connect error', async () => {
    const connect = vi.fn(async () => {
      throw new Error('no project id');
    });
    const transport = makeTransport({ connect });
    const store = createStore(transport);
    renderWithProviders(<ConnectPanel />, { transport, store });
    await userEvent.click(screen.getByTestId('wallet-connect-cta'));
    expect(await screen.findByTestId('wallet-connect-error')).toHaveTextContent('no project id');
  });
});
