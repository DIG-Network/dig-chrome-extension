import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { DerivedAddressList } from '@/features/wallet/custody/DerivedAddressList';

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

/** A small deterministic page: `count` indexes × both schemes. */
function page(count: number) {
  const addresses = [];
  for (let i = 0; i < count; i++) {
    addresses.push({ index: i, scheme: 'unhardened', address: `xch1unh${i}${'0'.repeat(50)}` });
    addresses.push({ index: i, scheme: 'hardened', address: `xch1hrd${i}${'0'.repeat(50)}` });
  }
  return addresses;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DerivedAddressList (#106)', () => {
  it('shows a loading state, then both schemes for the derived page', async () => {
    mockSw((m) => (m.action === 'listDerivedAddresses' ? { addresses: page(5) } : { success: true }));
    renderWithProviders(<DerivedAddressList />);
    expect(await screen.findByTestId('derived-address-unhardened-0')).toBeInTheDocument();
    expect(screen.getByTestId('derived-address-hardened-0')).toBeInTheDocument();
    expect(screen.getByTestId('derived-address-unhardened-4')).toBeInTheDocument();
  });

  it('shows an error state with retry on failure', async () => {
    let fail = true;
    const sw = mockSw((m) => {
      if (m.action !== 'listDerivedAddresses') return { success: true };
      if (fail) return { success: false, code: 'LOCKED' };
      return { addresses: page(1) };
    });
    renderWithProviders(<DerivedAddressList />);
    expect(await screen.findByTestId('derived-addresses-error')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByTestId('derived-addresses-retry'));
    await waitFor(() => expect(screen.getByTestId('derived-address-unhardened-0')).toBeInTheDocument());
    expect(sw).toHaveBeenCalled();
  });

  it('copies the full address (not the shortened display text) to the clipboard', async () => {
    mockSw((m) => (m.action === 'listDerivedAddresses' ? { addresses: page(1) } : { success: true }));
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(<DerivedAddressList />);
    const fullAddress = page(1)[0].address;
    await screen.findByTestId('derived-address-unhardened-0');
    await userEvent.click(screen.getByTestId('derived-address-copy-unhardened-0'));
    expect(writeText).toHaveBeenCalledWith(fullAddress);
    expect(await screen.findByTestId('derived-address-copy-unhardened-0')).toHaveTextContent(/copied/i);
  });

  it('"Show more" (generate fresh) reveals additional indexes without dropping earlier ones', async () => {
    const sw = mockSw((m) => (m.action === 'listDerivedAddresses' ? { addresses: page((m.count as number) ?? 5) } : { success: true }));
    renderWithProviders(<DerivedAddressList />);
    await screen.findByTestId('derived-address-unhardened-4');
    expect(screen.queryByTestId('derived-address-unhardened-5')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('derived-addresses-more'));

    await waitFor(() => expect(screen.getByTestId('derived-address-unhardened-9')).toBeInTheDocument());
    // Earlier indexes are still shown — "generate fresh" extends the page, it doesn't replace it.
    expect(screen.getByTestId('derived-address-unhardened-0')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'listDerivedAddresses', count: 10 }), expect.any(Function));
  });
});
