import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { XchtipButtonSection } from '@/features/tipping/XchtipButtonSection';

const ADDR = 'xch1z8dvd7jg0dl9wgy9lr5j0d0k5j3l4m6n7p8q9r0s1t2u3v4w5xq6y7z8a';

function mockSw(address: string | null) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: { action?: string } | undefined, cb?: (r: unknown) => void) => {
      const reply = msg?.action === 'getReceiveAddress' ? { address } : { success: false };
      if (cb) cb(reply);
      return Promise.resolve(reply);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('XchtipButtonSection', () => {
  it('prompts to unlock when there is no wallet address', async () => {
    mockSw(null);
    renderWithProviders(<XchtipButtonSection />);
    await waitFor(() => expect(screen.getByTestId('tip-xchtip-empty')).toBeTruthy());
  });

  it('generates the jar link, embed snippet, and builder link for a valid xch address', async () => {
    mockSw(ADDR);
    renderWithProviders(<XchtipButtonSection />);
    await waitFor(() => expect(screen.getByTestId('tip-xchtip-link')).toBeTruthy());
    expect((screen.getByTestId('tip-xchtip-link') as HTMLInputElement).value).toBe(`https://xchtip.app/jar/${ADDR}`);
    expect((screen.getByTestId('tip-xchtip-embed') as HTMLTextAreaElement).value).toContain(`data-recipient="${ADDR}"`);
    expect(screen.getByTestId('tip-xchtip-open').getAttribute('href')).toBe(`https://xchtip.app/jar/${ADDR}`);
    expect(screen.getByTestId('tip-xchtip-builder').getAttribute('href')).toBe(`https://xchtip.app/?recipient=${ADDR}&asset=xch`);
  });

  it('copies the link to the clipboard and flips to a "Copied" label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    mockSw(ADDR);
    renderWithProviders(<XchtipButtonSection />);
    await waitFor(() => expect(screen.getByTestId('tip-xchtip-link-copy')).toBeTruthy());
    fireEvent.click(screen.getByTestId('tip-xchtip-link-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://xchtip.app/jar/${ADDR}`));
  });
});
