import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyActivity } from '@/features/wallet/custody/CustodyActivity';
import type { ActivityEvent } from '@/offscreen/activity';

function mockSw(events: ActivityEvent[] | { error: true }) {
  const fn = vi.fn((msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
    let reply: unknown = { success: true };
    if (msg?.action === 'getActivity') reply = 'error' in events ? { success: false, code: 'X' } : { events, cursorHeight: 1 };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

afterEach(() => vi.restoreAllMocks());

const RECEIVED: ActivityEvent = { id: 'r:1', kind: 'received', asset: 'XCH', amount: '2510000000000', counterparty: null, height: 5, timestamp: 100, coinId: 'a'.repeat(64) };
const SENT: ActivityEvent = { id: 's:2', kind: 'sent', asset: 'XCH', amount: '250000000000', counterparty: 'xch1qqqqexampleqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz', height: 6, timestamp: 200, coinId: 'b'.repeat(64) };

describe('CustodyActivity', () => {
  it('renders human-sentence rows on success', async () => {
    mockSw([SENT, RECEIVED]);
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('activity-s:2')).toHaveTextContent('Sent 0.25 XCH');
    expect(screen.getByTestId('activity-r:1')).toHaveTextContent('Received 2.51 XCH');
  });

  it('#151 resolves a CAT transaction to its REAL registry ticker, not the generic "CAT" fallback', async () => {
    const tail = 'c'.repeat(64);
    const catReceived: ActivityEvent = { id: 'r:cat', kind: 'received', asset: tail, amount: '2500', counterparty: null, height: 7, timestamp: 300, coinId: 'c'.repeat(64) };
    mockSw([catReceived]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, tokens: [{ id: tail, name: 'Gamma Coin', code: 'GMA', denom: 1000 }] }),
      })),
    );
    renderWithProviders(<CustodyActivity />);
    const row = await screen.findByTestId('activity-r:cat');
    expect(row).toHaveTextContent('Received 2.5 GMA'); // real ticker from the registry, not "CAT"
    vi.unstubAllGlobals();
  });

  it('expands a row to its receipt (coin id + SpaceScan)', async () => {
    mockSw([SENT]);
    renderWithProviders(<CustodyActivity />);
    fireEvent.click(await screen.findByTestId('activity-line-s:2'));
    expect(screen.getByTestId('activity-receipt-s:2')).toHaveTextContent('b'.repeat(64));
    expect(screen.getByTestId('activity-spacescan-s:2')).toBeInTheDocument();
  });

  it('shows the empty state when there is no activity', async () => {
    mockSw([]);
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('custody-activity-list-empty')).toBeInTheDocument();
  });

  it('shows the error state + retry on failure', async () => {
    mockSw({ error: true });
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('custody-activity-list-error')).toBeInTheDocument();
    expect(screen.getByTestId('custody-activity-list-retry')).toBeInTheDocument();
  });
});
