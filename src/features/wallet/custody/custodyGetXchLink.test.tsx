import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { DIG_ASSET_ID, GET_XCH_URL } from '@/lib/links';

/**
 * #210 — the "Get more XCH" link is wired onto the REAL XCH asset row in the wired `CustodyWallet`
 * (not just the isolated `GetXchLink`/`AssetRow` unit tests), and appears on NO other row — the
 * mirror image of #202's $DIG-only "Get more" menu (`custodyGetDigMenu.test.tsx`).
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

describe('CustodyWallet — "Get more XCH" link (#210)', () => {
  it('renders the Get-more link on the XCH row only, pointing at chia.net/buy-xch', async () => {
    renderWithProviders(<CustodyWallet />);
    expect(await screen.findByTestId('asset-xch')).toBeInTheDocument();

    // The XCH row carries the link; the $DIG row does not.
    const xchRow = screen.getByTestId('asset-xch');
    const link = xchRow.querySelector('[data-testid="getxch-link"]') as HTMLAnchorElement | null;
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', GET_XCH_URL);
    expect(link).toHaveAttribute('target', '_blank');

    expect(await screen.findByTestId('asset-dig')).toBeInTheDocument();
    const digRow = screen.getByTestId('asset-dig');
    expect(digRow.querySelector('[data-testid="getxch-link"]')).toBeNull();
  });
});
