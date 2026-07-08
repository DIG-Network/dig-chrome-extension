import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ControlTab } from '@/features/control/ControlTab';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockControl(payload: unknown) {
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    cb?.(msg.action === ACTIONS.getControlStatus ? payload : { success: true });
  }) as never;
}

describe('ControlTab', () => {
  it('renders the install prompt when no local node is present (#82: via react-intl, endpoint interpolated)', async () => {
    mockControl({ mode: 'install', localNode: false, base: null, controlEndpoint: null, readFallback: 'https://rpc.dig.net/', status: null, authRequired: false, controlMethods: [] });
    renderWithProviders(<ControlTab />);
    expect(await screen.findByTestId('control-install')).toBeInTheDocument();
    expect(screen.getByTestId('control-panel')).toHaveAttribute('data-mode', 'install');
    expect(screen.getByTestId('control-install-note')).toHaveTextContent(/dig-node/i);
    // The hosted-fallback line interpolates the actual endpoint (§82 — was a template literal).
    expect(screen.getByTestId('control-read-fallback')).toHaveTextContent('https://rpc.dig.net/');
  });

  it('renders the manage view + stats when a local node is running (#82: stats interpolated via react-intl)', async () => {
    mockControl({
      mode: 'manage',
      localNode: true,
      base: 'http://dig.local',
      controlEndpoint: 'http://dig.local/',
      readFallback: 'https://rpc.dig.net/',
      status: { hosted_store_count: 3, cached_capsule_count: 12, cache: { used_bytes: 1000 }, sync: { available: true } },
      authRequired: true,
      controlMethods: [],
    });
    renderWithProviders(<ControlTab />);
    expect(await screen.findByTestId('control-stats')).toBeInTheDocument();
    expect(screen.getByTestId('control-stats')).toHaveTextContent('3');
    expect(screen.getByTestId('control-stats')).toHaveTextContent('12');
    expect(screen.getByTestId('control-panel')).toHaveAttribute('data-mode', 'manage');
    expect(screen.getByTestId('control-manage-note')).toHaveTextContent(/DIG Browser|native/i);
    expect(screen.getByTestId('control-read-fallback')).toHaveTextContent(/local/i);
  });
});
