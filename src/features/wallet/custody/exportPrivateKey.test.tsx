import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ExportPrivateKey } from '@/features/wallet/custody/ExportPrivateKey';

/**
 * Component tests for the private-key export reveal (#96, §18.20). The export op lives behind the SW
 * seam; a mock returns the two-scheme key set only for the right password. The revealed key renders
 * inside the closed-shadow-root `SecretPhrase` primitive (only its word count is on the host — the
 * hex itself is deliberately NOT scrapeable from the light DOM), so the assertions check the flow +
 * that the password gate holds, never that the secret text is present in the light DOM.
 */

function mockExport(password = 'pw') {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const m = msg as { action: string; password?: string };
    let reply: unknown = { success: true };
    if (m.action === 'exportPrivateKey') {
      reply = m.password === password
        ? { privateKeys: [{ scheme: 'unhardened', hex: 'aa'.repeat(32) }, { scheme: 'hardened', hex: 'bb'.repeat(32) }] }
        : { success: false, code: 'UNLOCK_FAILED', message: 'bad' };
    }
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('ExportPrivateKey (#96)', () => {
  it('reveals both schemes only after the correct password', async () => {
    mockExport('pw');
    renderWithProviders(<ExportPrivateKey />);
    fireEvent.change(screen.getByTestId('export-pk-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('export-pk-reveal'));
    await waitFor(() => screen.getByTestId('export-pk-result'));
    expect(screen.getByTestId('export-pk-unhardened')).toBeInTheDocument();
    expect(screen.getByTestId('export-pk-hardened')).toBeInTheDocument();
    // The hex is inside a CLOSED shadow root — only the (non-secret) word count is on the host.
    expect(screen.getByTestId('export-pk-words-unhardened')).toHaveAttribute('data-word-count', '1');
  });

  it('shows an error and reveals nothing on a wrong password', async () => {
    mockExport('pw');
    renderWithProviders(<ExportPrivateKey />);
    fireEvent.change(screen.getByTestId('export-pk-password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('export-pk-reveal'));
    await waitFor(() => screen.getByTestId('export-pk-error'));
    expect(screen.queryByTestId('export-pk-result')).toBeNull();
  });

  it('keeps the reveal button disabled until a password is entered', () => {
    mockExport('pw');
    renderWithProviders(<ExportPrivateKey />);
    expect(screen.getByTestId('export-pk-reveal')).toBeDisabled();
    fireEvent.change(screen.getByTestId('export-pk-password'), { target: { value: 'x' } });
    expect(screen.getByTestId('export-pk-reveal')).toBeEnabled();
  });

  it('copies a revealed key to the clipboard and clears it after the delay', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    mockExport('pw');
    renderWithProviders(<ExportPrivateKey clipboardClearMs={1000} />);
    fireEvent.change(screen.getByTestId('export-pk-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('export-pk-reveal'));
    // Resolve the reveal mutation (fake timers don't stall microtasks, but waitFor needs real ones).
    vi.useRealTimers();
    await waitFor(() => screen.getByTestId('export-pk-copy-unhardened'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('export-pk-copy-unhardened'));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('aa'.repeat(32));
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    // After the delay the clipboard is overwritten with empty string.
    expect(writeText).toHaveBeenCalledWith('');
    vi.useRealTimers();
  });
});
