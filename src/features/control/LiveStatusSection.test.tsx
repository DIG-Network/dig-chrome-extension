import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { LiveStatusSection, LiveStatusPill } from '@/features/control/LiveStatusSection';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockLive(status: Record<string, unknown>) {
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    cb?.(msg.action === ACTIONS.getNodeLiveStatus ? status : { success: true });
  }) as never;
}

describe('LiveStatusSection', () => {
  it('shows Connected with the node addr + version', async () => {
    mockLive({ state: 'connected', base: 'http://dig.local', addr: '127.0.0.1:9778', version: '0.12.0', commit: 'abc', updatedAt: 1 });
    renderWithProviders(<LiveStatusSection />);
    expect(await screen.findByTestId('control-live-pill')).toHaveTextContent(/connected/i);
    expect(screen.getByTestId('control-live-detail')).toHaveTextContent('127.0.0.1:9778');
    expect(screen.getByTestId('control-live-detail')).toHaveTextContent('0.12.0');
  });

  it('shows Offline when disconnected (no detail line)', async () => {
    mockLive({ state: 'disconnected', base: null, addr: null, version: null, commit: null, updatedAt: 1 });
    renderWithProviders(<LiveStatusSection />);
    expect(await screen.findByTestId('control-live-pill')).toHaveTextContent(/offline/i);
    expect(screen.queryByTestId('control-live-detail')).not.toBeInTheDocument();
  });

  it('LiveStatusPill reflects the state as a header pill', async () => {
    mockLive({ state: 'connecting', base: null, addr: null, version: null, commit: null, updatedAt: 1 });
    renderWithProviders(<LiveStatusPill />);
    expect(await screen.findByTestId('header-node-pill')).toHaveTextContent(/connecting/i);
  });
});
