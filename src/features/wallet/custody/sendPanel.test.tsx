import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { SendPanel } from '@/features/wallet/custody/SendPanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { DIG_ASSET_ID } from '@/lib/links';
import golden from '@/lib/keystore/derive.golden.json';

const RECIPIENT = golden.unhardened[0].address; // a valid xch1 bech32m address

/** An asset list with the given XCH balance (mojos) for the picker. */
function xchAssets(mojos: number) {
  return custodyAssetBalances({ xch: mojos, cats: {} }, []);
}

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const SUMMARY = { asset: 'XCH', sent: '250000000000', change: '749999000000', fee: '1000000', recipientPuzzleHashHex: 'ab', coinCount: 1 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SendPanel', () => {
  it('form → review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSw((m) => {
      if (m.action === 'prepareSend') return { pendingId: 'p1', summary: SUMMARY };
      if (m.action === 'confirmSend') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} pollMs={50} />);

    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByTestId('send-review'));

    expect(await screen.findByTestId('send-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('review-sent')).toHaveTextContent('0.25');

    fireEvent.click(screen.getByTestId('send-confirm'));
    expect(await screen.findByTestId('send-sending')).toBeInTheDocument();
    // poll fires → confirmed
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('send-confirmed')).toBeInTheDocument();
  });

  it('Max sets the amount to spendable minus fee', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);
    fireEvent.click(screen.getByTestId('send-max'));
    expect((screen.getByTestId('send-amount') as HTMLInputElement).value).toBe('1'); // 1 XCH, fee 0
  });

  it('rejects an amount exceeding spendable minus fee before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<SendPanel assets={xchAssets(100_000_000_000)} />); // 0.1 XCH
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('send-review'));
    expect(await screen.findByTestId('send-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSend' }), expect.any(Function));
  });

  it('sends a CAT — the asset picker forwards the assetId; Max is the full token balance', async () => {
    const sw = mockSw((m) =>
      m.action === 'prepareSend'
        ? { pendingId: 'p1', summary: { asset: DIG_ASSET_ID, sent: '1000', change: '0', fee: '0', recipientPuzzleHashHex: 'ab', coinCount: 1 } }
        : { success: true },
    );
    // XCH + $DIG (5.000 DIG, 3 decimals).
    const assets = custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [DIG_ASSET_ID]: 5000 } }, []);
    renderWithProviders(<SendPanel assets={assets} />);
    fireEvent.change(screen.getByTestId('send-asset'), { target: { value: '1' } }); // select $DIG
    fireEvent.click(screen.getByTestId('send-max'));
    expect((screen.getByTestId('send-amount') as HTMLInputElement).value).toBe('5'); // full 5 DIG (fee is XCH)
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('send-review'));
    expect(await screen.findByTestId('send-review-panel')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareSend', assetId: DIG_ASSET_ID, amount: '1000' }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareSend') return { pendingId: 'p1', summary: SUMMARY };
      if (m.action === 'confirmSend') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByTestId('send-review'));
    fireEvent.click(await screen.findByTestId('send-confirm'));
    expect(await screen.findByTestId('send-failed')).toBeInTheDocument();
  });
});
