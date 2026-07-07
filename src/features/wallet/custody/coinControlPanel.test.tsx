import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CoinControlPanel } from '@/features/wallet/custody/CoinControlPanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';

/**
 * Coin control UI (#91) — list → select → combine/split → review → confirm → confirmed, driven
 * against a mocked SW seam. Proves the panel forwards the right actions (listCoins / prepareCombine /
 * prepareSplit / confirmSend) with the selected coin ids and renders the four states.
 */

const COIN_A = 'aa'.repeat(32);
const COIN_B = 'bb'.repeat(32);
const COIN_C = 'cc'.repeat(32);

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const threeCoins = {
  coins: [
    { coinId: COIN_A, amount: '1000000000000', confirmedHeight: 10 },
    { coinId: COIN_B, amount: '2000000000000', confirmedHeight: 11 },
    { coinId: COIN_C, amount: '3000000000000', confirmedHeight: 12 },
  ],
};

const xchAssets = () => custodyAssetBalances({ xch: 6_000_000_000_000, cats: {} }, []);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CoinControlPanel', () => {
  it('lists the wallet coins for the selected asset', async () => {
    mockSw((m) => (m.action === 'listCoins' ? threeCoins : { success: true }));
    renderWithProviders(<CoinControlPanel assets={xchAssets()} />);
    expect(await screen.findByTestId(`coin-row-${COIN_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`coin-row-${COIN_B}`)).toBeInTheDocument();
    expect(screen.getByTestId(`coin-row-${COIN_C}`)).toBeInTheDocument();
  });

  it('combine: select ≥2 → prepareCombine with the ids → review → confirm → confirmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'listCoins') return threeCoins;
      if (m.action === 'prepareCombine') return { pendingId: 'p1', coinOpSummary: { asset: 'XCH', kind: 'combine', inputCoinCount: 2, outputCoinCount: 1, total: '3000000000000', fee: '0' } };
      if (m.action === 'confirmSend') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<CoinControlPanel assets={xchAssets()} pollMs={50} />);

    fireEvent.click(await screen.findByTestId(`coin-select-${COIN_A}`));
    fireEvent.click(screen.getByTestId(`coin-select-${COIN_B}`));
    const combine = screen.getByTestId('coins-combine') as HTMLButtonElement;
    expect(combine.disabled).toBe(false);
    fireEvent.click(combine);

    expect(await screen.findByTestId('coins-review')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareCombine', coinIds: [COIN_A, COIN_B] }), expect.any(Function));

    fireEvent.click(screen.getByTestId('coins-confirm'));
    expect(await screen.findByTestId('coins-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('coins-confirmed')).toBeInTheDocument();
  });

  it('combine is disabled with fewer than two coins selected', async () => {
    mockSw((m) => (m.action === 'listCoins' ? threeCoins : { success: true }));
    renderWithProviders(<CoinControlPanel assets={xchAssets()} />);
    await screen.findByTestId(`coin-row-${COIN_A}`);
    expect((screen.getByTestId('coins-combine') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`coin-select-${COIN_A}`));
    expect((screen.getByTestId('coins-combine') as HTMLButtonElement).disabled).toBe(true); // still <2
  });

  it('split: select exactly one → set outputs → prepareSplit with outputs → review', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'listCoins') return threeCoins;
      if (m.action === 'prepareSplit') return { pendingId: 'p2', coinOpSummary: { asset: 'XCH', kind: 'split', inputCoinCount: 1, outputCoinCount: 4, total: '1000000000000', fee: '0' } };
      return { success: true };
    });
    renderWithProviders(<CoinControlPanel assets={xchAssets()} />);

    fireEvent.click(await screen.findByTestId(`coin-select-${COIN_A}`));
    const split = screen.getByTestId('coins-split') as HTMLButtonElement;
    expect(split.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('coins-split-outputs'), { target: { value: '4' } });
    fireEvent.click(split);

    expect(await screen.findByTestId('coins-review')).toBeInTheDocument();
    expect(screen.getByTestId('coins-review-op')).toHaveTextContent('4');
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSplit', coinIds: [COIN_A], outputs: 4 }), expect.any(Function));
  });

  it('split is disabled unless exactly one coin is selected', async () => {
    mockSw((m) => (m.action === 'listCoins' ? threeCoins : { success: true }));
    renderWithProviders(<CoinControlPanel assets={xchAssets()} />);
    await screen.findByTestId(`coin-row-${COIN_A}`);
    expect((screen.getByTestId('coins-split') as HTMLButtonElement).disabled).toBe(true); // 0 selected
    fireEvent.click(screen.getByTestId(`coin-select-${COIN_A}`));
    fireEvent.click(screen.getByTestId(`coin-select-${COIN_B}`));
    expect((screen.getByTestId('coins-split') as HTMLButtonElement).disabled).toBe(true); // 2 selected
  });

  it('shows the empty state when the asset has no coins', async () => {
    mockSw((m) => (m.action === 'listCoins' ? { coins: [] } : { success: true }));
    renderWithProviders(<CoinControlPanel assets={xchAssets()} />);
    expect(await screen.findByTestId('coins-empty')).toBeInTheDocument();
  });

  it('#166: Close lives in the sticky ViewHeader, not the bottom of the (growable) coin list', async () => {
    mockSw((m) => (m.action === 'listCoins' ? { coins: [] } : { success: true }));
    renderWithProviders(<CoinControlPanel assets={xchAssets()} onClose={() => {}} />);
    await screen.findByTestId('coins-empty');
    const header = screen.getByTestId('view-header');
    expect(header).toContainElement(screen.getByTestId('coins-close'));
  });
});
