import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyableCommand } from '@/components/CopyableCommand';
import { renderWithProviders } from '@/test/harness';
import * as clipboard from '@/lib/clipboard';

describe('CopyableCommand (#500)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('copies the EXACT full command string via the shared clipboard helper on click', async () => {
    const spy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    renderWithProviders(
      <CopyableCommand command="dig-node pair approve e06381423f7cb7f33d3c42b9118385d6" testid="cmd" />,
    );
    await userEvent.click(screen.getByTestId('cmd'));
    // Load-bearing: asserts the FULL command, not a prefix/substring a lazier implementation
    // (e.g. copying just the hex id) would also satisfy.
    expect(spy).toHaveBeenCalledWith('dig-node pair approve e06381423f7cb7f33d3c42b9118385d6');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows "Copied!" feedback after a successful copy, then reverts after ~1.5s', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<CopyableCommand command="dig-node pair approve abc123" testid="cmd" />);

    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('cmd'));
    expect(await screen.findByText('Copied!')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('does not show "Copied!" when the copy fails', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(false);
    renderWithProviders(<CopyableCommand command="dig-node pair approve abc123" testid="cmd" />);
    await userEvent.click(screen.getByTestId('cmd'));
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('exposes an accessible "Copy command" label for screen readers', () => {
    renderWithProviders(<CopyableCommand command="dig-node pair approve abc123" testid="cmd" />);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  it('is keyboard-operable: Tab to focus, Enter triggers the copy', async () => {
    const spy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    renderWithProviders(<CopyableCommand command="dig-node pair approve abc123" testid="cmd" />);
    await userEvent.tab();
    expect(screen.getByTestId('cmd')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(spy).toHaveBeenCalledWith('dig-node pair approve abc123');
  });

  it('is keyboard-operable: Space also triggers the copy', async () => {
    const spy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    renderWithProviders(<CopyableCommand command="dig-node pair approve abc123" testid="cmd" />);
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(spy).toHaveBeenCalledWith('dig-node pair approve abc123');
  });
});
