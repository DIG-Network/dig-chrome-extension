import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { DIG_ASSET_ID, GET_DIG_SOURCES } from '@/lib/links';

/**
 * #202 — the "Get more $DIG" menu is wired onto the REAL $DIG asset row in the wired `CustodyWallet`
 * (not just the isolated `GetDigMenu`/`AssetRow` unit tests), and appears on NO other row.
 */
function mockSw() {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const action = (msg as { action?: string }).action;
    let reply: unknown = { success: true };
    if (action === 'getCustodyBalances') {
      reply = { balances: { xch: 2_000_000_000_000, cats: { [DIG_ASSET_ID]: 10_000 } } };
    } else if (action === 'getReceiveAddress') {
      reply = { address: 'xch1receive' };
    }
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

beforeEach(async () => {
  await chrome.storage.local.remove('wallet.watchedCats');
  mockSw();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
});
afterEach(() => vi.restoreAllMocks());

describe('CustodyWallet — "Get more $DIG" menu (#202)', () => {
  it('renders the Get-more trigger on the $DIG row only, opening the 3 canonical venues', async () => {
    renderWithProviders(<CustodyWallet />);
    expect(await screen.findByTestId('asset-dig')).toBeInTheDocument();

    // The $DIG row carries the trigger; the XCH hero row does not.
    const digRow = screen.getByTestId('asset-dig');
    expect(digRow.querySelector('[data-testid="getdig-trigger"]')).toBeInTheDocument();
    const xchRow = screen.getByTestId('asset-xch');
    expect(xchRow.querySelector('[data-testid="getdig-trigger"]')).toBeNull();

    fireEvent.click(screen.getByTestId('getdig-trigger'));
    const links = screen.getAllByRole('menuitem') as HTMLAnchorElement[];
    expect(links.map((l) => l.getAttribute('href'))).toEqual(GET_DIG_SOURCES.map((s) => s.url));
  });
});
