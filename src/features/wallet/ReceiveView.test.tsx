import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
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

  /**
   * #166 — the Receive screen is a dedicated view (opened from an "Receive" action, not embedded
   * below the asset list), so the QR + address are the FIRST thing in it, in a sticky `ViewHeader`
   * back region — never buried below a growable CAT list. These assertions hold regardless of how
   * many CATs the wallet holds, because the CAT list simply isn't part of this screen at all.
   */
  it('puts the QR + address inside the sticky ViewHeader region as the whole screen (no asset list beside it)', () => {
    renderWithProviders(<ReceiveView address="xch1exampleaddress" onBack={() => {}} />);
    const header = screen.getByTestId('view-header');
    expect(header.tagName).toBe('HEADER');
    // The screen's only content besides the header is the QR + address card — nothing else can
    // ever push it down, independent of asset/CAT count.
    expect(screen.getByTestId('wallet-receive')).toBeInTheDocument();
    expect(screen.queryByTestId('custody-assets')).not.toBeInTheDocument();
  });

  it('wires the header back action to onBack', () => {
    const onBack = vi.fn();
    renderWithProviders(<ReceiveView address="xch1exampleaddress" onBack={onBack} />);
    fireEvent.click(screen.getByTestId('receive-close'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('omits the back action when onBack is not provided', () => {
    const { unmount } = renderWithProviders(<ReceiveView address="xch1exampleaddress" onBack={() => {}} />);
    unmount();
    renderWithProviders(<ReceiveView address="xch1exampleaddress" />);
    expect(screen.queryByTestId('receive-close')).not.toBeInTheDocument();
  });

  it('shows the header back action on the empty state too (no address yet)', () => {
    const onBack = vi.fn();
    renderWithProviders(<ReceiveView address={undefined} onBack={onBack} />);
    fireEvent.click(screen.getByTestId('receive-close'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
