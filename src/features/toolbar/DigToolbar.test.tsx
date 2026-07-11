import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DigToolbar } from '@/features/toolbar/DigToolbar';
import { TOOLBAR_ENABLED_KEY } from '@/lib/toolbar';

const STORE = 'a'.repeat(64);
const sendMessage = () => chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

async function enable(on: boolean) {
  if (on) await chrome.storage.local.set({ [TOOLBAR_ENABLED_KEY]: true });
  else await chrome.storage.local.remove(TOOLBAR_ENABLED_KEY);
}

describe('DigToolbar — built-in fullscreen URN toolbar (#306 item 1)', () => {
  beforeEach(async () => {
    sendMessage().mockClear();
    await enable(false);
  });

  it('renders nothing while the toolbar toggle is OFF', async () => {
    const { container } = render(<DigToolbar />);
    // give useStorageValue a tick to hydrate the (absent) value
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="builtin-dig-toolbar"]')).toBeNull();
  });

  it('shows the URN bar when enabled and routes a chia:// address via navigateToDigUrl (#289 path)', async () => {
    await enable(true);
    render(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, `chia://${STORE}{Enter}`);
    await waitFor(() =>
      expect(sendMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigateToDigUrl', url: expect.stringContaining(STORE) }),
        expect.any(Function),
      ),
    );
  });

  it('routes an *.on.dig.net shorthand via navigateDigInput (HEAD→URN #308)', async () => {
    await enable(true);
    render(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, 'shop.on.dig.net{Enter}');
    await waitFor(() =>
      expect(sendMessage()).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'navigateDigInput', input: 'shop.on.dig.net' }),
        expect.any(Function),
      ),
    );
  });

  it('marks the field invalid on non-DIG input instead of navigating', async () => {
    await enable(true);
    render(<DigToolbar />);
    const input = await screen.findByTestId('builtin-dig-toolbar-urn-input');
    await userEvent.type(input, 'just some words{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(sendMessage()).not.toHaveBeenCalled();
  });

  it('renders the verified + local badges when a node serve verdict is supplied', async () => {
    await enable(true);
    render(<DigToolbar verdict={{ verified: true, root: null, source: 'local' }} />);
    expect(await screen.findByTestId('builtin-dig-toolbar-badge-verified')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('builtin-dig-toolbar-badge-local')).toBeInTheDocument();
  });
});
