import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

describe('ResolverTab', () => {
  it('opens a chia:// address in the active tab', async () => {
    const update = vi.fn(() => Promise.resolve({}));
    chrome.tabs.query = vi.fn((_q: unknown, cb: (t: { id: number }[]) => void) => cb([{ id: 5 }])) as never;
    chrome.tabs.update = update as never;
    renderWithProviders(<ResolverTab />);
    await userEvent.type(screen.getByTestId('chia-url-input'), 'example.xch');
    await userEvent.click(screen.getByTestId('chia-url-go'));
    expect(update).toHaveBeenCalledWith(5, { url: 'chia://example.xch' });
  });

  it('toggles chia:// resolution and messages the background', async () => {
    const send = vi.fn((_m: unknown, cb?: (r: unknown) => void) => cb?.({ success: true }));
    chrome.runtime.sendMessage = send as never;
    renderWithProviders(<ResolverTab />);
    await userEvent.click(screen.getByTestId('resolution-toggle'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: ACTIONS.toggleExtension }), expect.any(Function));
  });

  it('saves a custom node host', async () => {
    const send = vi.fn((_m: unknown, cb?: (r: unknown) => void) => cb?.({ success: true }));
    chrome.runtime.sendMessage = send as never;
    renderWithProviders(<ResolverTab />);
    await userEvent.type(screen.getByTestId('node-host-input'), 'my.node:8080');
    await userEvent.click(screen.getByTestId('node-host-save'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: ACTIONS.updateServerConfig, host: 'my.node:8080' }),
      expect.any(Function),
    );
  });

  // dig-dns Path-B proxy fallback (#175): the "Local .dig resolution" indicator reads the shared
  // getDigDnsStatus signal and renders it as a StatusPill (good/direct, warn/proxy, neutral/other).
  describe('dig-dns availability indicator', () => {
    function mockDigDnsStatus(response: unknown) {
      chrome.runtime.sendMessage = vi.fn((m: { action?: string }, cb?: (r: unknown) => void) => {
        const reply = m && m.action === ACTIONS.getDigDnsStatus ? response : { success: true };
        cb?.(reply);
        return Promise.resolve(reply);
      }) as never;
    }

    it('renders "Direct" with a good tone when dig-dns is reachable and no proxy is engaged', async () => {
      mockDigDnsStatus({ phase: 'direct', boundPort: 80, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: null });
      renderWithProviders(<ResolverTab />);
      const pill = await screen.findByTestId('digdns-status-pill');
      expect(pill).toHaveAttribute('data-tone', 'good');
      expect(pill).toHaveTextContent('Direct');
    });

    it('renders the proxy-fallback indicator with a warn tone when Path B is engaged', async () => {
      mockDigDnsStatus({
        phase: 'proxy',
        boundPort: 80,
        pacUrl: 'http://127.0.0.5:80/.dig/proxy.pac',
        loopbackIp: '127.0.0.5',
        proxyActive: true,
        lastProbeAt: 1,
        lastError: 'a .dig navigation failed via the direct path',
      });
      renderWithProviders(<ResolverTab />);
      const pill = await screen.findByTestId('digdns-status-pill');
      expect(pill).toHaveAttribute('data-tone', 'warn');
      expect(pill).toHaveTextContent('Using proxy fallback');
    });

    it('renders "Not detected" with a neutral tone when dig-dns is unreachable', async () => {
      mockDigDnsStatus({ phase: 'unavailable', boundPort: null, pacUrl: null, loopbackIp: '127.0.0.5', proxyActive: false, lastProbeAt: 1, lastError: 'dig-dns unreachable' });
      renderWithProviders(<ResolverTab />);
      const pill = await screen.findByTestId('digdns-status-pill');
      expect(pill).toHaveAttribute('data-tone', 'neutral');
      expect(pill).toHaveTextContent('Not detected');
    });
  });
});
