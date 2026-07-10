import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { PairingSection } from '@/features/control/PairingSection';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockPairing(state: Record<string, unknown>) {
  const calls: { action: string }[] = [];
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    calls.push(msg);
    cb?.(msg.action === ACTIONS.pairingState || msg.action.startsWith('pairing') ? state : { success: true });
  }) as never;
  return { calls };
}

describe('PairingSection', () => {
  it('unpaired: shows the pair button and hides the managed children', async () => {
    mockPairing({ phase: 'unpaired', pairingId: null, pairingCode: null, expiresMs: null, error: null, updatedAt: 0 });
    renderWithProviders(
      <PairingSection>
        <div data-testid="managed-child">managed</div>
      </PairingSection>,
    );
    expect(await screen.findByTestId('control-pairing-start')).toBeInTheDocument();
    expect(screen.queryByTestId('managed-child')).not.toBeInTheDocument();
  });

  it('awaiting: shows the compare-codes value + the approve instruction', async () => {
    mockPairing({ phase: 'awaiting', pairingId: 'pid123', pairingCode: '481920', expiresMs: Date.now() + 60000, error: null, updatedAt: 0 });
    renderWithProviders(<PairingSection><div /></PairingSection>);
    expect(await screen.findByTestId('control-pairing-code')).toHaveTextContent('481920');
    expect(screen.getByTestId('control-pairing-code')).toHaveTextContent('pid123');
  });

  it('paired: renders the managed children + an unpair control', async () => {
    mockPairing({ phase: 'paired', pairingId: null, pairingCode: null, expiresMs: null, error: null, updatedAt: 0 });
    renderWithProviders(
      <PairingSection>
        <div data-testid="managed-child">managed</div>
      </PairingSection>,
    );
    expect(await screen.findByTestId('control-pairing-managed')).toBeInTheDocument();
    expect(screen.getByTestId('managed-child')).toBeInTheDocument();
    expect(screen.getByTestId('control-pairing-unpair')).toBeInTheDocument();
  });

  it('start pairing dispatches the pairingStart action', async () => {
    const { calls } = mockPairing({ phase: 'unpaired', pairingId: null, pairingCode: null, expiresMs: null, error: null, updatedAt: 0 });
    renderWithProviders(<PairingSection><div /></PairingSection>);
    fireEvent.click(await screen.findByTestId('control-pairing-start'));
    await waitFor(() => expect(calls.some((c) => c.action === ACTIONS.pairingStart)).toBe(true));
  });
});
