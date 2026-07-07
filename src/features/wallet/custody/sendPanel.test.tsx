import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { SendPanel } from '@/features/wallet/custody/SendPanel';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { CONTACTS_KEY, RECENTS_KEY } from '@/features/contacts/useContacts';
import { normalizeAddress, type Contact } from '@/features/contacts/contacts';
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

beforeEach(async () => {
  await chrome.storage.local.remove(CONTACTS_KEY);
  await chrome.storage.local.remove(RECENTS_KEY);
});

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

  it('add-on-send: saves an unknown recipient in review → label preference flips + confirmation', async () => {
    mockSw((m) => (m.action === 'prepareSend' ? { pendingId: 'p1', summary: SUMMARY } : { success: true }));
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByTestId('send-review'));

    // Unknown recipient → the inline saver is offered (raw address shown, not a label).
    fireEvent.click(await screen.findByTestId('save-contact-open'));
    fireEvent.change(screen.getByTestId('save-contact-label'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('save-contact-save'));

    expect(await screen.findByTestId('save-contact-saved')).toBeInTheDocument();
    // The review recipient now prefers the just-saved label (same address-book instance).
    expect(await screen.findByTestId('review-recipient-label')).toHaveTextContent('Alice');
  });

  it('shows a saved contact by label: picker fills the address + the form shows the name', async () => {
    const contact: Contact = { id: 'c1', label: 'Alice', address: normalizeAddress(RECIPIENT), note: '', createdAt: 1, updatedAt: 1 };
    await chrome.storage.local.set({ [CONTACTS_KEY]: [contact] });
    mockSw(() => ({ success: true }));
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);

    fireEvent.click(await screen.findByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('pick-contact-c1'));

    expect((screen.getByTestId('send-recipient') as HTMLInputElement).value).toBe(normalizeAddress(RECIPIENT));
    await waitFor(() => expect(screen.getByTestId('send-recipient-contact')).toHaveTextContent('Alice'));
  });

  it('coin picker (#91): choosing coins forwards them as coinIds to prepareSend', async () => {
    const COIN = 'a1'.repeat(32);
    const sw = mockSw((m) => {
      if (m.action === 'listCoins') return { coins: [{ coinId: COIN, amount: '1000000000000', confirmedHeight: 3 }] };
      if (m.action === 'prepareSend') return { pendingId: 'p1', summary: SUMMARY };
      return { success: true };
    });
    renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);
    fireEvent.click(screen.getByTestId('send-choose-coins'));
    fireEvent.click(await screen.findByTestId(`send-coin-${COIN}`));
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByTestId('send-review'));
    expect(await screen.findByTestId('send-review-panel')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareSend', coinIds: [COIN] }), expect.any(Function));
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

  /**
   * #166 — the cancel/back affordance lives in the sticky ViewHeader (the top of the screen), not
   * scattered at the bottom of each phase's (possibly growable) form — so it's reachable at any
   * scroll position instead of buried below a long coin picker.
   */
  describe('#166 — cancel/back lives in the sticky ViewHeader', () => {
    it('form phase: Cancel is in the header and closes the panel', () => {
      const onClose = vi.fn();
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} onClose={onClose} />);
      const header = screen.getByTestId('view-header');
      const cancel = screen.getByTestId('send-cancel');
      expect(header).toContainElement(cancel);
      fireEvent.click(cancel);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('review phase: Back is in the header and returns to the form', async () => {
      mockSw((m) => (m.action === 'prepareSend' ? { pendingId: 'p1', summary: SUMMARY } : { success: true }));
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} />);
      fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
      fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
      fireEvent.click(screen.getByTestId('send-review'));
      await screen.findByTestId('send-review-panel');

      const header = screen.getByTestId('view-header');
      const back = screen.getByTestId('send-back');
      expect(header).toContainElement(back);
      fireEvent.click(back);
      expect(await screen.findByTestId('send-recipient')).toBeInTheDocument();
    });
  });

  /**
   * Clawback (#152) — an ADVANCED send option, FULLSCREEN-ONLY (§145): the popup (compact) surface
   * never shows it; the basic send stays untouched there. XCH only (v1) — hidden for a CAT.
   */
  describe('clawback (#152) — fullscreen-only advanced send option', () => {
    it('the popup surface (full=false) never renders the clawback toggle', () => {
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} full={false} />);
      expect(screen.queryByTestId('send-clawback-toggle')).not.toBeInTheDocument();
    });

    it('fullscreen (full=true) renders the toggle for an XCH send; a CAT selection hides it', () => {
      const assets = [
        ...xchAssets(1_000_000_000_000),
        { descriptor: { key: 'cat', assetId: DIG_ASSET_ID, ticker: '$DIG', name: 'DIG', decimals: 3 }, balance: 500, label: '0.5' } as never,
      ];
      renderWithProviders(<SendPanel assets={assets} full={true} />);
      expect(screen.getByTestId('send-clawback-toggle')).toBeInTheDocument();
      fireEvent.change(screen.getByTestId('send-asset'), { target: { value: '1' } }); // switch to the CAT
      expect(screen.queryByTestId('send-clawback-toggle')).not.toBeInTheDocument();
    });

    it('enabling the toggle reveals the window picker; disabling hides it again', () => {
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} full={true} />);
      expect(screen.queryByTestId('send-clawback-options')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('send-clawback-toggle'));
      expect(screen.getByTestId('send-clawback-window')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('send-clawback-toggle'));
      expect(screen.queryByTestId('send-clawback-options')).not.toBeInTheDocument();
    });

    it('submitting with clawback enabled sends an absolute clawbackSeconds computed from the chosen window', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const prepareSpy = vi.fn((m: { action: string; [k: string]: unknown }) =>
        m.action === 'prepareSend'
          ? { pendingId: 'p1', summary: SUMMARY, clawbackInfo: { senderPuzzleHashHex: 'aa', receiverPuzzleHashHex: 'bb', seconds: '1767225600', amount: '250000000000' } }
          : { success: true },
      );
      mockSw(prepareSpy);
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} full={true} />);

      fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
      fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
      fireEvent.click(screen.getByTestId('send-clawback-toggle'));
      fireEvent.change(screen.getByTestId('send-clawback-window'), { target: { value: '1h' } });
      fireEvent.click(screen.getByTestId('send-review'));

      await screen.findByTestId('send-review-panel');
      const call = prepareSpy.mock.calls.find(([m]) => (m as { action: string }).action === 'prepareSend');
      expect(call?.[0]).toMatchObject({ clawbackSeconds: String(Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000) + 3600) });
      // The review step shows the reclaim/claim deadline once the vault confirms it was a clawback send.
      expect(screen.getByTestId('review-clawback')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('a plain (non-clawback) send never sends clawbackSeconds', async () => {
      const prepareSpy = vi.fn((m: { action: string; [k: string]: unknown }) => (m.action === 'prepareSend' ? { pendingId: 'p1', summary: SUMMARY } : { success: true }));
      mockSw(prepareSpy);
      renderWithProviders(<SendPanel assets={xchAssets(1_000_000_000_000)} full={true} />);

      fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
      fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '0.25' } });
      fireEvent.click(screen.getByTestId('send-review'));

      await screen.findByTestId('send-review-panel');
      const call = prepareSpy.mock.calls.find(([m]) => (m as { action: string }).action === 'prepareSend');
      expect(call?.[0]).not.toHaveProperty('clawbackSeconds');
      expect(screen.queryByTestId('review-clawback')).not.toBeInTheDocument();
    });
  });
});
