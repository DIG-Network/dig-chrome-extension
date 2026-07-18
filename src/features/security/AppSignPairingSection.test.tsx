import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { AppSignPairingSection } from '@/features/security/AppSignPairingSection';

interface Sent {
  action?: string;
}

/**
 * Mock the SW seam for the APP-SIGN actions. `appSignStatus` returns the configured posture;
 * `appSignPair`/`appSignUnpair` succeed unless `pairFails` is set (then a §5.6.7 error envelope).
 * `sink` records every dispatched envelope.
 */
function mockSw(status: { paired: boolean; connState: string }, opts: { pairFails?: string } = {}, sink?: Sent[]) {
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      sink?.push(m);
      let r: unknown = { ok: true };
      if (m.action === 'appSignStatus') r = { ok: true, data: status };
      else if (m.action === 'appSignPair' && opts.pairFails) r = { ok: false, success: false, code: opts.pairFails, message: 'denied' };
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('AppSignPairingSection', () => {
  it('shows the Pair action + "Not paired" pill when the channel is up but unpaired', async () => {
    mockSw({ paired: false, connState: 'connected' });
    renderWithProviders(<AppSignPairingSection />);
    expect(await screen.findByTestId('appsign-pair')).toBeInTheDocument();
    expect(screen.getByTestId('appsign-state')).toHaveTextContent('Not paired');
  });

  it('shows the Unpair action + "Paired" pill when paired', async () => {
    mockSw({ paired: true, connState: 'connected' });
    renderWithProviders(<AppSignPairingSection />);
    expect(await screen.findByTestId('appsign-unpair')).toBeInTheDocument();
    expect(screen.getByTestId('appsign-state')).toHaveTextContent('Paired');
  });

  it('renders an honest "dig-app not running" state (never traps the user) when the channel is down', async () => {
    mockSw({ paired: false, connState: 'disconnected' });
    renderWithProviders(<AppSignPairingSection />);
    expect(await screen.findByTestId('appsign-appdown')).toBeInTheDocument();
    expect(screen.getByTestId('appsign-state')).toHaveTextContent('DIG app not running');
    expect(screen.queryByTestId('appsign-pair')).not.toBeInTheDocument();
  });

  it('dispatches appSignPair when the Pair button is clicked', async () => {
    const sink: Sent[] = [];
    mockSw({ paired: false, connState: 'connected' }, {}, sink);
    renderWithProviders(<AppSignPairingSection />);
    fireEvent.click(await screen.findByTestId('appsign-pair'));
    await waitFor(() => expect(sink.some((m) => m.action === 'appSignPair')).toBe(true));
  });

  it('surfaces the §5.6.7 error code when pairing is denied', async () => {
    mockSw({ paired: false, connState: 'connected' }, { pairFails: 'PAIR_DENIED' });
    renderWithProviders(<AppSignPairingSection />);
    fireEvent.click(await screen.findByTestId('appsign-pair'));
    expect(await screen.findByTestId('appsign-error')).toHaveTextContent('PAIR_DENIED');
  });
});
