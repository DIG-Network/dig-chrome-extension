import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResolverTab } from '@/features/resolver/ResolverTab';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '#shared/messages.mjs';

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
});
