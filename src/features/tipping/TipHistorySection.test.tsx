import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { TipHistorySection } from '@/features/tipping/TipHistorySection';

function mockSw(ledger: unknown) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { method?: string } | undefined, cb?: (r: unknown) => void) => {
      const reply = msg?.method === 'tip.get_ledger' ? ledger : { success: false };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

const nowSecs = Math.floor(Date.now() / 1000);
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  recipient_ph: 'ec7c30aabbcc',
  store_id: 'a'.repeat(64),
  dig_amount: 1500,
  ts: nowSecs,
  trigger: 'auto',
  kind: 'creator',
  status: 'confirmed',
  txid: 'b'.repeat(64),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('TipHistorySection', () => {
  it('shows the node-down note when the node is offline (no query fired)', () => {
    mockSw([]);
    renderWithProviders(<TipHistorySection nodeOnline={false} />);
    expect(screen.getByTestId('tip-history-nodedown')).toBeTruthy();
  });

  it('renders an informative empty-state when the ledger is empty (the #428 pre-broadcaster reality)', async () => {
    mockSw([]);
    renderWithProviders(<TipHistorySection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-history-empty')).toBeTruthy());
  });

  it('renders ledger rows with amount + tx link + a summary', async () => {
    mockSw([entry()]);
    renderWithProviders(<TipHistorySection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-history-table')).toBeTruthy());
    expect(screen.getByTestId('tip-amount').textContent).toContain('1.5 $DIG');
    expect(screen.getByTestId('tip-tx-link')).toBeTruthy();
    expect(screen.getByTestId('tip-history-summary')).toBeTruthy();
  });

  it('filters by timeframe — a 40-day-old tip drops out of "today"', async () => {
    const old = entry({ id: 'old', ts: nowSecs - 40 * 86400 });
    mockSw([entry({ id: 'recent' }), old]);
    renderWithProviders(<TipHistorySection nodeOnline />);
    await waitFor(() => expect(screen.getByTestId('tip-history-table')).toBeTruthy());
    expect(screen.getAllByTestId('tip-row')).toHaveLength(2); // "all" default
    fireEvent.click(screen.getByTestId('tip-timeframe-today'));
    await waitFor(() => expect(screen.getAllByTestId('tip-row')).toHaveLength(1));
  });
});
