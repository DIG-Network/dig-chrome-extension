import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { DidDetail } from '@/features/identity/DidDetail';
import type { WalletDid } from '@/offscreen/dids';
import golden from '@/lib/keystore/derive.golden.json';

const RECIPIENT = golden.unhardened[0].address;

function did(over: Partial<WalletDid> = {}): WalletDid {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    recoveryListHash: null,
    numVerificationsRequired: '1',
    profileName: null,
    ...over,
  };
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DidDetail', () => {
  it('shows on-chain data: launcher id, recovery state, verifications required', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-launcher-id')).toHaveTextContent('ab'.repeat(32));
    expect(screen.getByTestId('did-recovery')).toHaveTextContent(/no recovery/i);
    expect(screen.getByTestId('did-verifications')).toHaveTextContent('1');
  });

  it('shows a recovery-list-set indicator when the DID has one', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did({ recoveryListHash: 'aa'.repeat(32) })} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-recovery')).not.toHaveTextContent(/no recovery/i);
  });

  it('offers the transfer button on the fullscreen surface, never the fullscreen-affordance link', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-transfer-open')).toBeInTheDocument();
    expect(screen.queryByTestId('did-transfer-fullscreen')).not.toBeInTheDocument();
  });

  it('offers only an "open full screen" affordance on the popup surface — never the transfer form (#93/#145)', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull={false} onBack={() => {}} />);
    expect(screen.getByTestId('did-transfer-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('did-transfer-open')).not.toBeInTheDocument();
  });

  it('rejects an invalid recipient before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('did-transfer-open'));
    fireEvent.change(screen.getByTestId('did-transfer-recipient'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByTestId('did-transfer-review'));
    expect(await screen.findByTestId('did-transfer-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareDidTransfer' }), expect.any(Function));
  });

  it('form → review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareDidTransfer') return { pendingId: 'p1', didSummary: { launcherId: did().launcherId, recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 1 } };
      if (m.action === 'confirmDidTransfer') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} pollMs={50} />);

    fireEvent.click(screen.getByTestId('did-transfer-open'));
    fireEvent.change(screen.getByTestId('did-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('did-transfer-review'));

    expect(await screen.findByTestId('did-transfer-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('did-review-recipient')).toHaveTextContent(RECIPIENT);

    fireEvent.click(screen.getByTestId('did-transfer-confirm'));
    expect(await screen.findByTestId('did-transfer-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('did-transfer-confirmed')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareDidTransfer', launcherId: did().launcherId, recipient: RECIPIENT }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareDidTransfer') return { pendingId: 'p1', didSummary: { launcherId: did().launcherId, recipientPuzzleHashHex: 'ef', fee: '0', coinCount: 1 } };
      if (m.action === 'confirmDidTransfer') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('did-transfer-open'));
    fireEvent.change(screen.getByTestId('did-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('did-transfer-review'));
    fireEvent.click(await screen.findByTestId('did-transfer-confirm'));
    expect(await screen.findByTestId('did-transfer-failed')).toBeInTheDocument();
  });

  it('surfaces a build failure as an inline error', async () => {
    mockSw((m) => (m.action === 'prepareDidTransfer' ? { success: false, code: 'DID_NOT_FOUND' } : { success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('did-transfer-open'));
    fireEvent.change(screen.getByTestId('did-transfer-recipient'), { target: { value: RECIPIENT } });
    fireEvent.click(screen.getByTestId('did-transfer-review'));
    expect(await screen.findByTestId('did-transfer-error')).toBeInTheDocument();
  });

  it('has no WCAG violations (detail view)', async () => {
    mockSw(() => ({ success: true }));
    const { container } = renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('shows the profile name when set', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did({ profileName: 'Alice' })} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-profile-name')).toHaveTextContent('Alice');
  });

  it('shows "Not set" when the profile name is null', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-profile-name')).toHaveTextContent(/not set/i);
  });

  it('offers the edit-profile button on the fullscreen surface only', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    expect(screen.getByTestId('did-profile-open')).toBeInTheDocument();
  });

  it('does not offer edit-profile in the popup (only the shared "open full screen" affordance, #145)', () => {
    mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull={false} onBack={() => {}} />);
    expect(screen.queryByTestId('did-profile-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('did-transfer-fullscreen')).toBeInTheDocument();
  });

  it('rejects an empty profile name before building', async () => {
    const sw = mockSw(() => ({ success: true }));
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('did-profile-open'));
    fireEvent.change(screen.getByTestId('did-profile-name-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('did-profile-review'));
    expect(await screen.findByTestId('did-profile-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepareDidProfileUpdate' }), expect.any(Function));
  });

  it('profile: form → review → confirm → sending → confirmed (happy path with polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sw = mockSw((m) => {
      if (m.action === 'prepareDidProfileUpdate') return { pendingId: 'p1', didProfileSummary: { launcherId: did().launcherId, profileName: 'Alice', fee: '0', coinCount: 2 } };
      if (m.action === 'confirmDidProfileUpdate') return { spentCoinId: 'coin1' };
      if (m.action === 'sendStatus') return { confirmed: true };
      return { success: true };
    });
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} pollMs={50} />);

    fireEvent.click(screen.getByTestId('did-profile-open'));
    fireEvent.change(screen.getByTestId('did-profile-name-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('did-profile-review'));

    expect(await screen.findByTestId('did-profile-review-panel')).toBeInTheDocument();
    expect(screen.getByTestId('did-profile-review-name')).toHaveTextContent('Alice');

    fireEvent.click(screen.getByTestId('did-profile-confirm'));
    expect(await screen.findByTestId('did-profile-sending')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60);
    expect(await screen.findByTestId('did-profile-confirmed')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prepareDidProfileUpdate', launcherId: did().launcherId, profileName: 'Alice' }),
      expect.any(Function),
    );
  });

  it('shows the terminal failure state when the profile update broadcast is rejected', async () => {
    mockSw((m) => {
      if (m.action === 'prepareDidProfileUpdate') return { pendingId: 'p1', didProfileSummary: { launcherId: did().launcherId, profileName: 'Alice', fee: '0', coinCount: 2 } };
      if (m.action === 'confirmDidProfileUpdate') return { success: false, code: 'PUSH_FAILED' };
      return { success: true };
    });
    renderWithProviders(<DidDetail did={did()} isFull onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('did-profile-open'));
    fireEvent.change(screen.getByTestId('did-profile-name-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('did-profile-review'));
    fireEvent.click(await screen.findByTestId('did-profile-confirm'));
    expect(await screen.findByTestId('did-profile-failed')).toBeInTheDocument();
  });
});
