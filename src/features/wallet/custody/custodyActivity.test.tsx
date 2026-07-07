import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyActivity } from '@/features/wallet/custody/CustodyActivity';
import type { LocalActivityEntry } from '@/lib/activity-log';

function mockSw(events: LocalActivityEntry[] | { error: true }) {
  const fn = vi.fn((msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
    let reply: unknown = { success: true };
    if (msg?.action === 'getActivity') reply = 'error' in events ? { success: false, code: 'X' } : { events };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
}

afterEach(() => vi.restoreAllMocks());

const RECEIVED: LocalActivityEntry = { id: 'r:1', kind: 'received', asset: 'XCH', amount: '2510000000000', counterparty: null, timestamp: 100, coinId: 'a'.repeat(64), status: 'confirmed' };
const SENT: LocalActivityEntry = { id: 's:2', kind: 'sent', asset: 'XCH', amount: '250000000000', counterparty: 'xch1qqqqexampleqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz', timestamp: 200, coinId: 'b'.repeat(64), status: 'confirmed' };
const PENDING_SENT: LocalActivityEntry = { id: 's:3', kind: 'sent', asset: 'XCH', amount: '1000000', counterparty: 'xch1qqqqpendingqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzz', timestamp: 300, coinId: 'e'.repeat(64), status: 'pending' };

describe('CustodyActivity (#154 — local log, instant load, pending→confirmed)', () => {
  it('renders human-sentence rows on success', async () => {
    mockSw([SENT, RECEIVED]);
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('activity-s:2')).toHaveTextContent('Sent 0.25 XCH');
    expect(screen.getByTestId('activity-r:1')).toHaveTextContent('Received 2.51 XCH');
  });

  it('#151 resolves a CAT transaction to its REAL registry ticker, not the generic "CAT" fallback', async () => {
    const tail = 'c'.repeat(64);
    const catReceived: LocalActivityEntry = { id: 'r:cat', kind: 'received', asset: tail, amount: '2500', counterparty: null, timestamp: 300, coinId: 'c'.repeat(64), status: 'confirmed' };
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

  it('expands a row to its receipt (counterparty, confirmed status, coin id + SpaceScan)', async () => {
    mockSw([SENT]);
    renderWithProviders(<CustodyActivity />);
    fireEvent.click(await screen.findByTestId('activity-line-s:2'));
    const receipt = screen.getByTestId('activity-receipt-s:2');
    expect(receipt).toHaveTextContent('b'.repeat(64));
    expect(screen.getByTestId('activity-status-s:2')).toHaveTextContent('Confirmed');
    expect(screen.getByTestId('activity-spacescan-s:2')).toBeInTheDocument();
  });

  // #154 — the flagship pending→confirmed behavior: a just-broadcast send shows Pending immediately
  // and does NOT yet offer a SpaceScan link (the coin may not resolve on the explorer yet).
  it('#154 a pending entry shows a Pending status and no SpaceScan link', async () => {
    mockSw([PENDING_SENT]);
    renderWithProviders(<CustodyActivity />);
    fireEvent.click(await screen.findByTestId('activity-line-s:3'));
    expect(screen.getByTestId('activity-status-s:3')).toHaveTextContent('Pending');
    expect(screen.queryByTestId('activity-spacescan-s:3')).not.toBeInTheDocument();
  });

  it('#154 renders a mint/did entry with its own sentence + glyph, no crash on a non-token asset', async () => {
    const mint: LocalActivityEntry = { id: 'mint:1', kind: 'mint', asset: 'NFT', amount: '1', counterparty: null, timestamp: 400, coinId: 'd'.repeat(64), status: 'confirmed' };
    mockSw([mint]);
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('activity-mint:1')).toHaveTextContent('Minted 1 NFT');
  });

  it('#171 renders a bulk NFT burn entry with its own sentence + glyph, no counterparty', async () => {
    const burn: LocalActivityEntry = { id: 'burn:1', kind: 'burn', asset: 'NFT', amount: '3', counterparty: null, timestamp: 500, coinId: 'f'.repeat(64), status: 'confirmed' };
    mockSw([burn]);
    renderWithProviders(<CustodyActivity />);
    expect(await screen.findByTestId('activity-burn:1')).toHaveTextContent('Burned 3 NFT');
    fireEvent.click(screen.getByTestId('activity-line-burn:1'));
    // A burn has no counterparty (the destination has no spending key) — the receipt never shows "To".
    expect(screen.queryByTestId('activity-receipt-burn:1')).not.toHaveTextContent('To');
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
