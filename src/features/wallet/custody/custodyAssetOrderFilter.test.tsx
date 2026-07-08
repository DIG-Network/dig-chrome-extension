import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/harness';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';
import { COINGECKO_XCH_URL, DEXIE_TICKERS_URL } from '@/features/wallet/priceSources';
import { DEXIE_TOKENS_URL } from '@/features/wallet/catMetadata';
import { DIG_ASSET_ID } from '@/lib/links';

/**
 * #167 — value ordering + the live filter/autocomplete on the Assets list, exercised against the
 * REAL wired `CustodyWallet` (the SW seam + both public price/registry fetches mocked), same harness
 * as `custodyPrices.test.tsx`. Fast jsdom-level proof that the wiring is correct; the built-extension
 * Playwright spec (`e2e/sw/asset-list-order-filter.spec.ts`) proves the same behavior end-to-end.
 *
 * #202 revised the pinned order: XCH first, $DIG ALWAYS second (regardless of value), then the
 * remaining CATs by descending USD value. #204 additionally moved XCH + $DIG ABOVE the filter input
 * and excluded them from the filter predicate entirely — typing in the filter narrows only the
 * other CATs; XCH and $DIG never disappear or reorder.
 */

const CAT_A = 'a'.repeat(64); // registry: ticker "AAA" — ends up the highest-value row
const CAT_B = 'b'.repeat(64); // registry: ticker "BBB" — mid value
const CAT_C = 'c'.repeat(64); // NOT in the registry → falls back to the generic "CAT" ticker, no price

function mockSw() {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const action = (msg as { action?: string }).action;
    let reply: unknown = { success: true };
    if (action === 'getCustodyBalances') {
      reply = {
        balances: {
          xch: 2_000_000_000_000, // 2 XCH
          cats: {
            [DIG_ASSET_ID]: 10_000, // 10.000 $DIG
            [CAT_A]: 5000, // 5.000 AAA
            [CAT_B]: 2000, // 2.000 BBB
            [CAT_C]: 999_999_000, // huge raw amount, but unpriced + unresolved
          },
        },
      };
    } else if (action === 'getReceiveAddress') {
      reply = { address: 'xch1receive' };
    }
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

/** XCH=$10; AAA=1 XCH each→5×$10=$50 (highest); $DIG=0.05 XCH→10×$0.50=$5; BBB=0.1 XCH→2×$1=$2. */
function mockMarket() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === COINGECKO_XCH_URL) {
      return Promise.resolve({ ok: true, json: async () => ({ chia: { usd: 10, usd_24h_change: null } }) } as Response);
    }
    if (url === DEXIE_TICKERS_URL) {
      // AAA: 1 XCH each → 5 × $10 = $50. BBB: 0.1 XCH each → 2 × $1 = $2. DIG: 0.05 XCH → 10 × $0.50 = $5.
      // CAT_C is deliberately absent from the tickers → stays unpriced.
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tickers: [
            { base_id: CAT_A, target_id: 'xch', last_price: '1' },
            { base_id: CAT_B, target_id: 'xch', last_price: '0.1' },
            { base_id: DIG_ASSET_ID, target_id: 'xch', last_price: '0.05' },
          ],
        }),
      } as Response);
    }
    if (url === DEXIE_TOKENS_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          tokens: [
            { id: CAT_A, name: 'Alpha Token', code: 'AAA', denom: 1000 },
            { id: CAT_B, name: 'Beta Token', code: 'BBB', denom: 1000 },
          ],
        }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

beforeEach(async () => {
  await chrome.storage.local.remove('wallet.watchedCats');
  mockSw();
  mockMarket();
});
afterEach(() => vi.restoreAllMocks());

describe('CustodyWallet — value-ordered + filterable Assets list (#167, pin order per #202)', () => {
  it('keeps XCH first, $DIG pinned second, then sorts the rest by descending USD value (AAA $50 > BBB $2 > unpriced CAT last)', async () => {
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());

    const rows = screen.getByTestId('custody-assets').querySelectorAll('.dig-asset');
    const testids = [...rows].map((r) => r.getAttribute('data-testid'));
    expect(testids).toEqual(['asset-xch', 'asset-dig', `asset-cat-${CAT_A}`, `asset-cat-${CAT_B}`, `asset-cat-${CAT_C}`]);
  });

  // #204 — XCH + $DIG are PINNED above the filter input and are never removed/reordered by it; only
  // the other CATs (here AAA/BBB) are ever narrowed.
  it('narrows the list live as the user types (ticker or name), leaving XCH AND $DIG visible (#204)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());

    await user.type(screen.getByTestId('asset-filter-input'), 'alpha');

    expect(screen.getByTestId('asset-xch')).toBeInTheDocument(); // pinned row unaffected by the filter
    expect(screen.getByTestId('asset-dig')).toBeInTheDocument(); // pinned row unaffected by the filter (#204)
    expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`asset-cat-${CAT_B}`)).not.toBeInTheDocument();
  });

  it('#204 renders XCH then $DIG ABOVE the filter input, with the filterable CATs below it', async () => {
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());

    const children = [...screen.getByTestId('custody-assets').children];
    const testids = children.map((el) => el.getAttribute('data-testid'));
    // Pinned XCH, pinned $DIG, THEN the filter field, THEN the filterable (value-sorted) CATs.
    expect(testids).toEqual(['asset-xch', 'asset-dig', 'asset-filter', `asset-cat-${CAT_A}`, `asset-cat-${CAT_B}`, `asset-cat-${CAT_C}`]);
  });

  it('#204 a filter query matching nothing still leaves XCH + $DIG visible (only the CAT list empties)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());

    await user.type(screen.getByTestId('asset-filter-input'), 'nonexistent-token-zzz');

    expect(screen.getByTestId('asset-xch')).toBeInTheDocument();
    expect(screen.getByTestId('asset-dig')).toBeInTheDocument();
    expect(await screen.findByTestId('custody-assets-filter-empty')).toBeInTheDocument();
  });

  it('shows a clear empty state when nothing matches, and restores the list on Clear', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());

    await user.type(screen.getByTestId('asset-filter-input'), 'nonexistent-token-zzz');
    expect(await screen.findByTestId('custody-assets-filter-empty')).toBeInTheDocument();
    expect(screen.queryByTestId(`asset-cat-${CAT_A}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId('asset-filter-clear'));
    expect(screen.queryByTestId('custody-assets-filter-empty')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_A}`)).toBeInTheDocument());
    expect(screen.getByTestId(`asset-cat-${CAT_B}`)).toBeInTheDocument();
  });

  it('offers an autocomplete suggestion for a held CAT by its registry name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustodyWallet />);
    await waitFor(() => expect(screen.getByTestId(`asset-cat-${CAT_B}`)).toBeInTheDocument());

    await user.type(screen.getByTestId('asset-filter-input'), 'bet');
    const input = screen.getByTestId('asset-filter-input') as HTMLInputElement;
    const options = [...(input.list?.querySelectorAll('option') ?? [])].map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('BBB');
  });
});
