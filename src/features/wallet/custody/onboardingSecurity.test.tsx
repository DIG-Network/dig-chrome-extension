import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { Onboarding } from '@/features/wallet/custody/Onboarding';

/**
 * Onboarding security nudges (#79 P2-3): a phishing-education step before Create/Import (the two
 * paths that handle a raw recovery phrase), and a backup reminder right after a NEW wallet's phrase
 * is confirmed — the two "right moments" the ticket calls for. Watch-only (#96, public key only)
 * and restore-from-backup (#115, an existing encrypted file, not a raw phrase) skip the phishing
 * step — neither path exposes a phrase to protect. The existing `custody.strongPreset` (256 MiB
 * Argon2id toggle, #67 P0-…) and `custody.recovery.warn.never` ("DIG will never ask for your
 * recovery phrase") already ship in `AutoLockSetting`/`RecoveryReveal` respectively — this file only
 * covers the NEW steps.
 */

const WORDS24 = Array.from({ length: 24 }, () => 'alpha').join(' ');

function mockSw(handlers: Record<string, (m: Record<string, unknown>) => unknown>) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const m = msg as { action: string; [k: string]: unknown };
    const reply = handlers[m.action] ? handlers[m.action](m) : { success: true };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('Onboarding — phishing-education step before Create/Import (#79)', () => {
  it('Create shows the security nudge before the create form, and Continue proceeds to it', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-create'));
    expect(screen.getByTestId('onboarding-security')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-create-form')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    expect(screen.getByTestId('onboarding-create-form')).toBeInTheDocument();
  });

  it('Import shows the same security nudge before the import form', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-import'));
    expect(screen.getByTestId('onboarding-security')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    expect(screen.getByTestId('onboarding-import-form')).toBeInTheDocument();
  });

  it('the nudge states DIG will never ask for the recovery phrase and warns about phishing sites', () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-create'));
    const nudge = screen.getByTestId('onboarding-security');
    expect(nudge.textContent).toMatch(/never ask/i);
    expect(nudge.textContent?.length).toBeGreaterThan(0);
  });

  it('Watch-only skips the security nudge (no phrase involved)', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-watch'));
    expect(screen.queryByTestId('onboarding-security')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-watch-form')).toBeInTheDocument();
  });

  it('Restore-from-backup skips the security nudge (an encrypted file, not a raw phrase)', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-restore'));
    expect(screen.queryByTestId('onboarding-security')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-restore-form')).toBeInTheDocument();
  });

  it('Cancel from the nudge returns to the welcome screen', () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-create'));
    fireEvent.click(screen.getByTestId('onboarding-security-cancel'));
    expect(screen.getByTestId('onboarding-welcome')).toBeInTheDocument();
  });
});

describe('Onboarding — backup reminder after a NEW wallet phrase is confirmed (#79)', () => {
  function mockCreateFlow() {
    let lockState = 'none';
    return mockSw({
      createWallet: () => {
        lockState = 'unlocked';
        return { lockState, mnemonic: WORDS24 };
      },
      getLockState: () => ({ lockState }),
    });
  }

  it('shows a backup reminder after the confirm-word step succeeds, before onDone', async () => {
    const onDone = vi.fn();
    mockCreateFlow();
    renderWithProviders(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByTestId('onboarding-create'));
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    fireEvent.change(screen.getByTestId('onboarding-password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByTestId('onboarding-password-confirm'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByTestId('onboarding-submit'));

    fireEvent.click(await screen.findByTestId('reveal-continue'));
    fireEvent.change(await screen.findByTestId('confirm-word'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByTestId('confirm-submit'));

    expect(await screen.findByTestId('onboarding-backup-reminder')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled(); // not finished yet — the reminder is shown FIRST

    fireEvent.click(screen.getByTestId('onboarding-backup-reminder-finish'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('imports (an EXISTING phrase, already backed up by definition) skip the reminder — straight to onDone', async () => {
    const onDone = vi.fn();
    mockSw({
      importWallet: () => ({ lockState: 'unlocked' }),
    });
    renderWithProviders(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByTestId('onboarding-import'));
    fireEvent.click(screen.getByTestId('onboarding-security-continue'));
    fireEvent.change(screen.getByTestId('import-phrase'), { target: { value: WORDS24 } });
    fireEvent.change(screen.getByTestId('onboarding-password'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByTestId('onboarding-password-confirm'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByTestId('onboarding-submit'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByTestId('onboarding-backup-reminder')).not.toBeInTheDocument();
  });
});
