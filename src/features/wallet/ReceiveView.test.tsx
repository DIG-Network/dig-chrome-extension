import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReceiveView } from '@/features/wallet/ReceiveView';
import { renderWithProviders } from '@/test/harness';

describe('ReceiveView', () => {
  it('shows an empty state without an address', () => {
    renderWithProviders(<ReceiveView address={undefined} />);
    expect(screen.getByTestId('receive-empty')).toBeInTheDocument();
  });

  it('renders the address + QR and copies on click', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(<ReceiveView address="xch1exampleaddress" />);
    expect(screen.getByTestId('wallet-address')).toHaveValue('xch1exampleaddress');
    await userEvent.click(screen.getByTestId('receive-copy'));
    expect(writeText).toHaveBeenCalledWith('xch1exampleaddress');
  });
});
