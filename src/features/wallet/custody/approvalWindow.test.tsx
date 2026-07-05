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
});
