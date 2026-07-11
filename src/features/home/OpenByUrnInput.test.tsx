import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenByUrnInput } from '@/features/home/OpenByUrnInput';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

const STORE_ID = 'c'.repeat(64);
// base32 label for 32 bytes of 0xCC (hex "c".repeat(64)) — the .dig-scheme host this store id maps to.
const STORE_LABEL = 'ztgmztgmztgmztgmztgmztgmztgmztgmztgmztgmztgmztgmztga';

/** Mock `chrome.runtime.sendMessage` so `getDigDnsStatus` answers `response`, everything else `{success:true}`. */
function mockDigDnsStatus(response: unknown) {
  chrome.runtime.sendMessage = vi.fn((m: { action?: string } | undefined, cb?: (r: unknown) => void) => {
    const reply = m && m.action === ACTIONS.getDigDnsStatus ? response : { success: true };
    cb?.(reply);
    return Promise.resolve(reply);
  }) as never;
}

describe('OpenByUrnInput (#172 home-screen open-by-URN)', () => {
  it('renders a labeled input and a go button', () => {
    mockDigDnsStatus({ phase: 'unavailable' });
    renderWithProviders(<OpenByUrnInput />);
    expect(screen.getByTestId('home-openurn-input')).toBeInTheDocument();
    expect(screen.getByTestId('home-openurn-go')).toBeInTheDocument();
    expect(screen.getByLabelText(/chia:\/\/|urn/i)).toBeInTheDocument();
  });

  it('#312 — renders as a flush docked bar, not a floating .dig-widget card', () => {
    mockDigDnsStatus({ phase: 'unavailable' });
    renderWithProviders(<OpenByUrnInput />);
    const root = screen.getByTestId('home-openurn');
    // Docked-flush marker present; the old floating-card class is gone.
    expect(root).toHaveClass('dig-openurn--flush');
    expect(root).not.toHaveClass('dig-widget');
  });

  it('shows an inline error for a non-empty invalid address and does not navigate', async () => {
    mockDigDnsStatus({ phase: 'unavailable' });
    const send = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    renderWithProviders(<OpenByUrnInput />);
    await userEvent.type(screen.getByTestId('home-openurn-input'), 'not a valid address');
    await userEvent.click(screen.getByTestId('home-openurn-go'));
    expect(await screen.findByTestId('home-openurn-error')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ action: ACTIONS.navigateToDigUrl }), expect.anything());
  });

  it('clears the error once the user edits the field again', async () => {
    mockDigDnsStatus({ phase: 'unavailable' });
    renderWithProviders(<OpenByUrnInput />);
    await userEvent.type(screen.getByTestId('home-openurn-input'), 'not valid');
    await userEvent.click(screen.getByTestId('home-openurn-go'));
    expect(await screen.findByTestId('home-openurn-error')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('home-openurn-input'), 'x');
    expect(screen.queryByTestId('home-openurn-error')).not.toBeInTheDocument();
  });

  it('does nothing on an empty submit (no error flash, no navigation)', async () => {
    mockDigDnsStatus({ phase: 'unavailable' });
    renderWithProviders(<OpenByUrnInput />);
    await userEvent.click(screen.getByTestId('home-openurn-go'));
    expect(screen.queryByTestId('home-openurn-error')).not.toBeInTheDocument();
  });

  describe('dig-dns UNAVAILABLE -> the chrome-extension:// content view', () => {
    it('hands the canonical chia:// URL to the background navigateToDigUrl action', async () => {
      mockDigDnsStatus({ phase: 'unavailable', boundPort: null, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null });
      const send = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
      renderWithProviders(<OpenByUrnInput />);
      await userEvent.type(screen.getByTestId('home-openurn-input'), `chia://${STORE_ID}`);
      await userEvent.click(screen.getByTestId('home-openurn-go'));
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ action: ACTIONS.navigateToDigUrl, url: `chia://chia:${STORE_ID}/index.html` }),
          expect.any(Function),
        ),
      );
    });

    it('submits via Enter as well as the Go button', async () => {
      mockDigDnsStatus({ phase: 'unavailable' });
      const send = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
      renderWithProviders(<OpenByUrnInput />);
      await userEvent.type(screen.getByTestId('home-openurn-input'), `chia://${STORE_ID}{Enter}`);
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: ACTIONS.navigateToDigUrl }), expect.any(Function)),
      );
    });
  });

  describe('dig-dns DIRECT -> the native .dig scheme', () => {
    it('navigates the active tab to http://<storeLabel>.dig/', async () => {
      mockDigDnsStatus({ phase: 'direct', boundPort: 80, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null });
      const update = vi.fn(() => Promise.resolve({}));
      chrome.tabs.query = vi.fn((_q: unknown, cb: (t: { id: number }[]) => void) => cb([{ id: 7 }])) as never;
      chrome.tabs.update = update as never;
      renderWithProviders(<OpenByUrnInput />);
      await screen.findByTestId('home-openurn-input');
      await userEvent.type(screen.getByTestId('home-openurn-input'), `chia://${STORE_ID}`);
      await userEvent.click(screen.getByTestId('home-openurn-go'));
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith(7, { url: `http://${STORE_LABEL}.dig/` }));
    });
  });

  describe('dig-dns PROXY (self-heal fallback engaged) -> the native .dig scheme too', () => {
    it('still navigates to the .dig scheme (proxy makes it reachable)', async () => {
      mockDigDnsStatus({ phase: 'proxy', boundPort: 80, pacUrl: 'http://127.0.0.5:80/.dig/proxy.pac', loopbackIp: '127.0.0.5', proxyActive: true, lastProbeAt: 1, lastError: null });
      const update = vi.fn(() => Promise.resolve({}));
      chrome.tabs.query = vi.fn((_q: unknown, cb: (t: { id: number }[]) => void) => cb([{ id: 9 }])) as never;
      chrome.tabs.update = update as never;
      renderWithProviders(<OpenByUrnInput />);
      await screen.findByTestId('home-openurn-input');
      await userEvent.type(screen.getByTestId('home-openurn-input'), `chia://${STORE_ID}`);
      await userEvent.click(screen.getByTestId('home-openurn-go'));
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith(9, { url: `http://${STORE_LABEL}.dig/` }));
    });
  });
});
