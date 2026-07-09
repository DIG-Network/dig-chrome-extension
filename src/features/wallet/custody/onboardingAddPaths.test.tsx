import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { Onboarding } from '@/features/wallet/custody/Onboarding';

/**
 * Onboarding tests for the two NEW add-wallet paths (#96 watch-only, #115 restore-from-backup). The
 * existing create/import flow is covered in custody.test.tsx — this file only exercises the added
 * branches: entry buttons on the welcome screen, the watch-only public-key form, and the file-based
 * restore. The SW seam is mocked directly.
 */

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

describe('Onboarding — watch-only add path (#96)', () => {
  it('the welcome screen offers a watch-only entry that opens the public-key form', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-watch'));
    expect(screen.getByTestId('onboarding-watch-form')).toBeInTheDocument();
    expect(screen.getByTestId('watch-public-key')).toBeInTheDocument();
  });

  it('submits the public key to importWatchWallet and finishes on success', async () => {
    const onDone = vi.fn();
    const send = mockSw({ importWatchWallet: () => ({ success: true, activeWalletId: 'w2', address: 'xch1abc', fingerprint: 123 }) });
    renderWithProviders(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByTestId('onboarding-watch'));
    fireEvent.change(screen.getByTestId('watch-public-key'), { target: { value: 'aa'.repeat(48) } });
    fireEvent.click(screen.getByTestId('watch-submit'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'importWatchWallet');
    expect((call![0] as { publicKeyHex: string }).publicKeyHex).toBe('aa'.repeat(48));
  });

  it('shows an error for an invalid public key', async () => {
    mockSw({ importWatchWallet: () => ({ success: false, code: 'INVALID_PUBLIC_KEY', message: 'bad' }) });
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-watch'));
    fireEvent.change(screen.getByTestId('watch-public-key'), { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByTestId('watch-submit'));
    await waitFor(() => screen.getByTestId('watch-error'));
  });
});

describe('Onboarding — restore-from-backup add path (#115)', () => {
  it('the welcome screen offers a restore entry that opens the file picker step', async () => {
    mockSw({});
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-restore'));
    expect(screen.getByTestId('onboarding-restore-form')).toBeInTheDocument();
    expect(screen.getByTestId('restore-file')).toBeInTheDocument();
  });

  /** A File whose `.text()` reliably resolves under jsdom (its Blob.text can be absent/flaky). */
  function jsonFile(json: string): File {
    const file = new File([json], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(json), configurable: true });
    return file;
  }

  it('reads the chosen file and posts its text to importWalletBackup, finishing on success', async () => {
    const onDone = vi.fn();
    const send = mockSw({ importWalletBackup: () => ({ success: true, activeWalletId: 'w3', lockState: 'locked' }) });
    renderWithProviders(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByTestId('onboarding-restore'));
    fireEvent.change(screen.getByTestId('restore-file'), { target: { files: [jsonFile('{"magic":"DIGWBK1","version":1}')] } });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = send.mock.calls.find((c) => (c[0] as { action?: string }).action === 'importWalletBackup');
    expect((call![0] as { json: string }).json).toContain('DIGWBK1');
  });

  it('shows a duplicate error when the wallet already exists', async () => {
    mockSw({ importWalletBackup: () => ({ success: false, code: 'ALREADY_EXISTS', message: 'dup' }) });
    renderWithProviders(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('onboarding-restore'));
    fireEvent.change(screen.getByTestId('restore-file'), { target: { files: [jsonFile('{"magic":"DIGWBK1","version":1}')] } });
    await waitFor(() => screen.getByTestId('restore-error'));
  });
});
