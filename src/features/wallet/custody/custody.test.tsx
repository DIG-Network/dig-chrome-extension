import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { CustodyGate } from '@/features/wallet/custody/CustodyGate';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { NoWalletCard } from '@/features/wallet/custody/NoWalletCard';
import { RecoveryReveal } from '@/features/wallet/custody/RecoveryReveal';

/** Route SW messages by action so the custody endpoints resolve deterministically. */
function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

function setWide(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    matches,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const WORDS24 = Array(24).fill('alpha').join(' ');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => setWide(false));

describe('CustodyGate', () => {
  it('renders children when unlocked', async () => {
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'unlocked' } : {}));
    renderWithProviders(
      <CustodyGate>
        <div data-testid="wallet-body">wallet</div>
      </CustodyGate>,
    );
    expect(await screen.findByTestId('wallet-body')).toBeInTheDocument();
  });

  it('shows the UnlockScreen when locked', async () => {
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'locked' } : {}));
    renderWithProviders(<CustodyGate><div data-testid="wallet-body" /></CustodyGate>);
    expect(await screen.findByTestId('custody-unlock')).toBeInTheDocument();
  });

  it('shows the compact no-wallet CTA when there is no wallet (popup)', async () => {
    setWide(false);
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'none' } : {}));
    renderWithProviders(<CustodyGate><div data-testid="wallet-body" /></CustodyGate>);
    expect(await screen.findByTestId('custody-nowallet')).toBeInTheDocument();
  });

  it('shows the full Onboarding flow when there is no wallet (fullscreen)', async () => {
    setWide(true);
    mockSw((m) => (m.action === 'getLockState' ? { lockState: 'none' } : {}));
    renderWithProviders(<CustodyGate><div data-testid="wallet-body" /></CustodyGate>);
    expect(await screen.findByTestId('custody-onboarding')).toBeInTheDocument();
  });

  // #162: the error placeholder is a FIRST-load-only state (`!everHydrated`) — once the slice mirror
  // has hydrated, a later `getLockState` hiccup (e.g. right after an identity-changing mutation resets
  // the whole cache) must NOT tear down the already-rendered wallet body / onboarding flow.
  it('shows a recoverable error on the very first load when getLockState fails', async () => {
    mockSw((m) =>
      m.action === 'getLockState' ? { success: false, code: 'RUNTIME', message: 'boom' } : {},
    );
    renderWithProviders(<CustodyGate><div data-testid="wallet-body" /></CustodyGate>);
    expect(await screen.findByTestId('custody-lockstate-error')).toBeInTheDocument();
  });
});

describe('UnlockScreen', () => {
  it('unlocks with a password and shows an error on failure', async () => {
    const sw = mockSw((m) =>
      m.action === 'unlockWallet' && m.password === 'right'
        ? { lockState: 'unlocked' }
        : { success: false, code: 'UNLOCK_FAILED' },
    );
    renderWithProviders(<UnlockScreen />);
    fireEvent.change(screen.getByTestId('unlock-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('unlock-submit'));
    expect(await screen.findByTestId('unlock-error')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'unlockWallet', password: 'wrong' }), expect.any(Function));
  });
});

describe('NoWalletCard', () => {
  it('opens fullscreen onboarding on setup', async () => {
    renderWithProviders(<NoWalletCard />);
    fireEvent.click(screen.getByTestId('nowallet-setup'));
    await waitFor(() => expect(chrome.tabs.create).toHaveBeenCalled());
  });
});

describe('RecoveryReveal', () => {
  it('hides the words until revealed, then renders 24 in a scrape-proof closed shadow root', () => {
    const { container } = renderWithProviders(<RecoveryReveal mnemonic={WORDS24} />);
    expect(screen.queryByTestId('recovery-words')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recovery-reveal-btn'));
    const host = screen.getByTestId('recovery-words');
    // The secret lives in a CLOSED shadow root (#67 P1-5): host.shadowRoot is null and the words
    // never appear in the light DOM, so another extension / injected script / the rest of our own
    // UI cannot scrape them via document.querySelector or textContent harvesting.
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(container.textContent).not.toContain('alpha');
    expect(host.getAttribute('data-word-count')).toBe('24');
  });

  it('copies to the clipboard and auto-clears it', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<RecoveryReveal mnemonic={WORDS24} clipboardClearMs={1000} />);
    fireEvent.click(screen.getByTestId('recovery-reveal-btn'));
    fireEvent.click(screen.getByTestId('recovery-copy'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(WORDS24));
    await vi.advanceTimersByTimeAsync(1100);
    expect(writeText).toHaveBeenLastCalledWith(''); // clipboard cleared
  });
});

/** A stateful SW mock: getLockState reflects create/import flipping the wallet to unlocked. */
function mockSwStateful(extra: (m: { action: string; [k: string]: unknown }) => unknown = () => ({})) {
  let lockState = 'none';
  return mockSw((m) => {
    if (m.action === 'getLockState') return { lockState };
    if (m.action === 'createWallet') { lockState = 'unlocked'; return { lockState, mnemonic: WORDS24 }; }
    if (m.action === 'importWallet') { lockState = 'unlocked'; return { lockState }; }
    return extra(m);
  });
}

describe('Onboarding (create flow)', () => {
  it('creates a wallet, reveals + confirms the phrase, then completes', async () => {
    setWide(true);
    const sw = mockSwStateful();
    renderWithProviders(<CustodyGate><div data-testid="wallet-body">done</div></CustodyGate>);

    fireEvent.click(await screen.findByTestId('onboarding-create'));
    // #79 — the phishing-education nudge appears before the create form; Continue proceeds to it.
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    fireEvent.change(screen.getByTestId('onboarding-password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByTestId('onboarding-password-confirm'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByTestId('onboarding-submit'));

    // Reveal step appears with the returned phrase.
    fireEvent.click(await screen.findByTestId('reveal-continue'));
    // Confirm a word (all words are "alpha").
    fireEvent.change(await screen.findByTestId('confirm-word'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByTestId('confirm-submit'));

    // #79 — a backup reminder appears before the gate proceeds to the wallet; Finish completes it.
    fireEvent.click(await screen.findByTestId('onboarding-backup-reminder-finish'));

    expect(await screen.findByTestId('wallet-body')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith(expect.objectContaining({ action: 'createWallet', password: 'password1' }), expect.any(Function));
  });

  it('rejects mismatched passwords before calling the SW', async () => {
    setWide(true);
    const sw = mockSw((m) => (m.action === 'getLockState' ? { lockState: 'none' } : {}));
    renderWithProviders(<CustodyGate><div /></CustodyGate>);
    fireEvent.click(await screen.findByTestId('onboarding-create'));
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    fireEvent.change(screen.getByTestId('onboarding-password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByTestId('onboarding-password-confirm'), { target: { value: 'different' } });
    fireEvent.click(screen.getByTestId('onboarding-submit'));
    expect(await screen.findByTestId('onboarding-error')).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'createWallet' }), expect.any(Function));
  });

  it('imports a recovery phrase', async () => {
    setWide(true);
    mockSwStateful();
    renderWithProviders(<CustodyGate><div data-testid="wallet-body">done</div></CustodyGate>);
    fireEvent.click(await screen.findByTestId('onboarding-import'));
    // #79 — the SAME phishing-education nudge appears before the import form.
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    fireEvent.change(screen.getByTestId('import-phrase'), { target: { value: WORDS24 } });
    fireEvent.change(screen.getByTestId('onboarding-password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByTestId('onboarding-password-confirm'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByTestId('onboarding-submit'));
    // Import skips the backup reminder (an existing phrase is already backed up by definition) —
    // straight to the wallet.
    expect(await screen.findByTestId('wallet-body')).toBeInTheDocument();
  });
});
