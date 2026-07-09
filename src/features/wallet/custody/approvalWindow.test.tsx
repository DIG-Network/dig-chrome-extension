import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ApprovalWindow } from '@/features/wallet/custody/ApprovalWindow';

/**
 * The SW-summoned dApp approval window (#56 §5.5). Drives it over the mocked SW seam: the queue
 * (`dappApprovalList`) + the decision (`dappApprovalResolve`). Asserts the decoded summary renders,
 * approve/reject reach the SW with the right decision, and the locked / decode-error branches.
 */

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

const CAT = 'a406d3961da0da3daa196ca9f2f81bafda9d7d3e3d8b25de5b3616fa9c9f2f81';

/**
 * Stub `global.fetch` for the price + CAT-registry queries the approval window's fiat-equivalent
 * + CAT-naming enrichment (#77 P2-1) reads (`@/features/wallet/priceApi` + `@/features/wallet/
 * catMetadataApi` — SEPARATE api slices from the SW seam, fetched directly over HTTPS). Unit tests
 * default `global.fetch` to a rejection (`vitest.setup.ts`) so this is opt-in per test; XCH = $20,
 * the given CAT = $2 (quoted at 0.1 XCH), registered as ticker "SBX" / 3 decimals.
 */
function mockPricesAndCatRegistry() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('coingecko')) {
        return { ok: true, json: async () => ({ chia: { usd: 20, usd_24h_change: 1 } }) };
      }
      if (url.includes('dexie.space/v2/prices/tickers')) {
        return { ok: true, json: async () => ({ tickers: [{ base_id: CAT, target_id: 'xch', target_code: 'XCH', last_price: 0.1 }] }) };
      }
      if (url.includes('dexie.space/v1/swap/tokens')) {
        return { ok: true, json: async () => ({ tokens: [{ id: CAT, name: 'Spacebucks', code: 'SBX', denom: 1000, icon: 'https://icons.dexie.space/x.png' }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch,
  );
}

const SPEND_SUMMARY = {
  coinCount: 1,
  inputs: [{ coinId: 'a1', puzzleHash: 'd2', amount: '1000000000000', isSelf: true }],
  outputs: [{ puzzleHash: 'e3', amount: '250000000000', isSelf: false }],
  feeMojos: '1000000',
  sendingMojos: '250000000000',
  changeMojos: '749000000000',
  allInputsSelf: true,
  requiredSigners: ['aa'],
  ownedSigners: 1,
};

function signRequest(over = {}) {
  return { id: 'r1', origin: 'https://dapp.example', method: 'chip0002_signCoinSpends', kind: 'signCoinSpends', summary: SPEND_SUMMARY, needsUnlock: false, decodeError: false, createdAt: 1, ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals(); // undo mockPricesAndCatRegistry()'s vi.stubGlobal('fetch', …) between tests
  vi.useRealTimers();
});

describe('ApprovalWindow', () => {
  it('renders the decoded coin-spend summary (origin, amounts, signatures)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);

    expect(await screen.findByTestId('approval-request')).toBeInTheDocument();
    expect(screen.getByTestId('approval-origin')).toHaveTextContent('https://dapp.example');
    expect(screen.getByTestId('approval-sending')).toHaveTextContent('0.25');
    expect(screen.getByTestId('approval-fee')).toHaveTextContent('0.000001');
    expect(screen.getByTestId('approval-signatures')).toHaveTextContent('1');
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });

  it('Approve sends the decision to the SW with approved:true', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      if (m.action === 'dappApprovalResolve') return { success: true, remaining: 0 };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    fireEvent.click(await screen.findByTestId('approval-approve'));
    await waitFor(() => {
      expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'dappApprovalResolve', id: 'r1', approved: true }), expect.anything());
    });
  });

  it('Reject sends the decision to the SW with approved:false', async () => {
    const sw = mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      if (m.action === 'dappApprovalResolve') return { success: true, remaining: 0 };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    fireEvent.click(await screen.findByTestId('approval-reject'));
    await waitFor(() => {
      expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'dappApprovalResolve', id: 'r1', approved: false }), expect.anything());
    });
  });

  it('a locked request shows the unlock gate and disables Approve', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ summary: null, needsUnlock: true })], lockState: 'locked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-locked')).toBeInTheDocument();
    expect(screen.getByTestId('custody-unlock')).toBeInTheDocument();
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
  });

  it('an undecodable request offers only Reject', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ summary: null, decodeError: true })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-decode-error')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reject')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument();
  });

  it('a message-sign request shows the exact message being signed', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 'm1', method: 'chip0002_signMessage', kind: 'signMessage', summary: { message: 'gm from dexie', publicKey: 'ab'.repeat(48) } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-message')).toHaveTextContent('gm from dexie');
    expect(screen.getByTestId('approval-signed-as')).toBeInTheDocument();
  });

  it('an empty queue renders the empty state', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [], lockState: 'unlocked', summoned: false };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-empty')).toBeInTheDocument();
  });

  it('warns when the wallet cannot fully sign the request', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ summary: { ...SPEND_SUMMARY, ownedSigners: 0 } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-cannot-sign')).toBeInTheDocument();
  });

  it('flags an over-broad/foreign-signer spend as HIGH, lists the unaccountable signer, and gates Approve behind an ack (#75)', async () => {
    const foreignPk = 'ab'.repeat(48);
    const summary = { ...SPEND_SUMMARY, ownedSigners: 0, requiredSigners: [foreignPk], unaccountedSigners: [foreignPk] };
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ summary })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    // The signer the wallet cannot account for is surfaced, and the risk banner is HIGH.
    expect(await screen.findByTestId('approval-unaccounted-signers')).toBeInTheDocument();
    expect(screen.getByTestId('approval-risk')).toHaveAttribute('data-risk-level', 'high');
    expect(screen.getByTestId('approval-risk-CANNOT_SIGN')).toBeInTheDocument();
    // Approve is blocked until the risk is explicitly acknowledged (not silently signable).
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
    fireEvent.click(screen.getByTestId('approval-risk-ack-input'));
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });

  it('shows a high-risk drainer banner and gates Approve behind an explicit acknowledgement (#67 P0-3)', async () => {
    const drain = { ...SPEND_SUMMARY, sendingMojos: '1000000000000', changeMojos: '0', outputs: [{ puzzleHash: 'e3', amount: '1000000000000', isSelf: false }] };
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ summary: drain })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    const banner = await screen.findByTestId('approval-risk');
    expect(banner).toHaveAttribute('data-risk-level', 'high');
    expect(screen.getByTestId('approval-risk-DRAIN_ALL')).toBeInTheDocument();
    // Approve is disabled until the risk acknowledgement is checked.
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
    fireEvent.click(screen.getByTestId('approval-risk-ack-input'));
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });

  it('does not show a risk banner for a normal payment and Approve is enabled (#67 P0-3)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-request')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-risk')).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });

  it('a blocklisted origin shows a hard interstitial and offers only Reject (#67 P0-2)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ originRisk: { verdict: 'block', reason: 'BLOCKLISTED' } })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    const banner = await screen.findByTestId('approval-origin-risk');
    expect(banner).toHaveAttribute('data-origin-verdict', 'block');
    expect(screen.getByTestId('approval-origin-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reject')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-spend-summary')).not.toBeInTheDocument();
  });

  it('renders a wallet-built send summary (recipient, amount, fee)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 's1', method: 'chia_send', kind: 'send', summary: { asset: 'XCH', sent: '250000000000', change: '0', fee: '1000000', recipientPuzzleHashHex: 'ab'.repeat(16), coinCount: 1 } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-send-summary')).toBeInTheDocument();
    expect(screen.getByTestId('approval-send-amount')).toHaveTextContent('0.25');
    expect(screen.getByTestId('approval-send-fee')).toHaveTextContent('0.000001');
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });

  it('renders a two-sided trade summary (give vs receive) for takeOffer', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 'o1', method: 'chia_takeOffer', kind: 'takeOffer', summary: { offered: [{ asset: { kind: 'xch' }, amount: '100000000000' }], requested: [{ asset: { kind: 'cat', assetId: 'cc'.repeat(32) }, amount: '5000', toPuzzleHashHex: 'ab' }] } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-offer-summary')).toBeInTheDocument();
    expect(screen.getByTestId('approval-offer-give')).toHaveTextContent('0.1 XCH');
    // #77 — an unregistered CAT still renders human decimal units (base-unit ÷ CAT_DECIMALS) + the
    // generic "CAT" ticker fallback, never the raw base-unit integer it showed before.
    expect(screen.getByTestId('approval-offer-receive')).toHaveTextContent('5 CAT');
  });

  it('runs drainer risk assessment on a sendTransaction bundle (dApp-built spend)', async () => {
    const drain = { ...SPEND_SUMMARY, sendingMojos: '1000000000000', changeMojos: '0', outputs: [{ puzzleHash: 'e3', amount: '1000000000000', isSelf: false }] };
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ id: 'tx1', method: 'chia_sendTransaction', kind: 'sendTransaction', summary: drain })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-spend-summary')).toBeInTheDocument();
    expect(screen.getByTestId('approval-risk')).toHaveAttribute('data-risk-level', 'high');
  });

  it('shows a preparing state and holds Approve while the summary is still building (null, no error)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 'b1', method: 'chia_send', kind: 'send', summary: null, needsUnlock: false, decodeError: false })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-preparing')).toBeInTheDocument();
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
    expect(screen.getByTestId('approval-reject')).toBeEnabled();
  });

  it('a lookalike origin warns and gates Approve behind an acknowledgement (#67 P0-2)', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest({ originRisk: { verdict: 'warn', reason: 'LOOKALIKE' } })], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    const banner = await screen.findByTestId('approval-origin-risk');
    expect(banner).toHaveAttribute('data-origin-verdict', 'warn');
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
    fireEvent.click(screen.getByTestId('approval-risk-ack-input'));
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
  });
});

describe('ApprovalWindow — richer rendering: fiat equivalents + CAT naming + raw view (#77 P2-1)', () => {
  it('shows a fiat equivalent + the resolved CAT ticker for a wallet-built CAT send', async () => {
    mockPricesAndCatRegistry();
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 'cs1', method: 'chia_send', kind: 'send', summary: { asset: CAT, sent: '5000', change: '0', fee: '0', recipientPuzzleHashHex: 'ab'.repeat(16), coinCount: 1 } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    const amount = await screen.findByTestId('approval-send-amount');
    // 5000 base units / 1000 (denom→3 decimals) = 5 SBX (the registered ticker, not the raw TAIL).
    expect(amount).toHaveTextContent('5 SBX');
    // 5 SBX * $2 = $10 (the resolved CAT price is 0.1 XCH * $20 XCH-USD anchor).
    await waitFor(() => expect(amount).toHaveTextContent('$10.00'));
  });

  it('shows fiat equivalents next to the sending/change/fee amounts of a dApp-built spend', async () => {
    mockPricesAndCatRegistry();
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    // SPEND_SUMMARY sends 0.25 XCH — at $20/XCH that is $5.00.
    await waitFor(() => expect(screen.getByTestId('approval-sending')).toHaveTextContent('$5.00'));
  });

  it('shows an expandable raw view of the decoded summary for review before approving', async () => {
    mockSw((m) => {
      if (m.action === 'dappApprovalList') return { requests: [signRequest()], lockState: 'unlocked', summoned: true };
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    const raw = await screen.findByTestId('approval-raw-view');
    // Collapsed by default (no clutter on first render); expanding reveals the exact decoded facts.
    fireEvent.click(raw.querySelector('summary')!);
    expect(raw).toHaveTextContent('sendingMojos');
    expect(raw).toHaveTextContent('250000000000');
  });

  it('never blocks or hides the approval when fiat/CAT-name lookups fail (graceful degrade)', async () => {
    // The default unit-test fetch stub rejects every call — no mockPricesAndCatRegistry() here.
    mockSw((m) => {
      if (m.action === 'dappApprovalList') {
        return { requests: [signRequest({ id: 'cs2', method: 'chia_send', kind: 'send', summary: { asset: CAT, sent: '5000', change: '0', fee: '0', recipientPuzzleHashHex: 'ab'.repeat(16), coinCount: 1 } })], lockState: 'unlocked', summoned: true };
      }
      return { success: true };
    });
    renderWithProviders(<ApprovalWindow />);
    expect(await screen.findByTestId('approval-send-summary')).toBeInTheDocument();
    // Falls back to the short-form TAIL + generic "CAT" ticker; no fiat equivalent text at all
    // (never a fabricated $0) — and Approve is still available.
    expect(screen.getByTestId('approval-approve')).toBeEnabled();
    expect(screen.queryByTestId('approval-fiat-equivalent')).not.toBeInTheDocument();
  });
});
