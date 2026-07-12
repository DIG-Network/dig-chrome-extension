import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { ShieldTab } from '@/features/shield/ShieldTab';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockLedger(payload: unknown, verifyPayload: unknown = { success: false, code: 'NO_LOCAL_NODE', message: 'x' }) {
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    if (msg.action === ACTIONS.getShieldLedger) cb?.(payload);
    else if (msg.action === ACTIONS.getVerifyLedger) cb?.(verifyPayload);
    else cb?.({ success: true });
  }) as never;
}

const verifyLedger = (over: Record<string, unknown> = {}) => ({
  storeId: 'aa'.repeat(32),
  root: 'bb'.repeat(32),
  resources: [
    { resourceKey: 'index.html', source: 'local', verified: true, root: 'bb'.repeat(32), proof: { leafHash: '00'.repeat(32), siblings: [], leafIndex: 0, proofRoot: 'bb'.repeat(32) } },
    { resourceKey: 'evil.js', source: 'rpc', verified: false, root: 'bb'.repeat(32), proof: { leafHash: 'ff'.repeat(32), siblings: [], leafIndex: 1, proofRoot: 'cd'.repeat(32) }, failReason: 'DIG_ERR_PROOF_MISMATCH' },
  ],
  ...over,
});

const entry = (path: string, passed: boolean) => ({
  resourcePath: path,
  storeId: 'aa'.repeat(32),
  rootHash: 'bb'.repeat(32),
  inclusionProofPassed: passed,
  errorCode: passed ? '' : 'DIG_ERR_PROOF_MISMATCH',
  executionProofStatus: '',
});

describe('ShieldTab', () => {
  it('shows the empty state when nothing is verified', async () => {
    mockLedger({ capsule: null, verification: null, group: { passed: [], failed: [], passedCount: 0, failedCount: 0, total: 0, allPassed: false, empty: true }, entries: [] });
    renderWithProviders(<ShieldTab />);
    expect(await screen.findByTestId('shield-empty')).toBeInTheDocument();
  });

  it('renders the capsule + verified/failed groups', async () => {
    mockLedger({
      capsule: { storeId: 'aa'.repeat(32), rootHash: 'bb'.repeat(32) },
      verification: { state: 'failed' },
      group: {
        passed: [entry('index.html', true)],
        failed: [entry('app.js', false)],
        passedCount: 1,
        failedCount: 1,
        total: 2,
        allPassed: false,
        empty: false,
      },
      entries: [],
    });
    renderWithProviders(<ShieldTab />);
    expect(await screen.findByTestId('shield-verdict')).toBeInTheDocument();
    expect(await screen.findByTestId('shield-passed-item')).toBeInTheDocument();
    expect(await screen.findByTestId('shield-failed-item')).toBeInTheDocument();
  });

  it('the aggregate badge reads "Unverified" when an RPC resource failed verification', async () => {
    mockLedger(
      { capsule: null, verification: null, group: { passed: [], failed: [], passedCount: 0, failedCount: 0, total: 0, allPassed: false, empty: true }, entries: [] },
      verifyLedger(),
    );
    renderWithProviders(<ShieldTab />);
    const badge = await screen.findByTestId('verify-badge');
    expect(badge).toHaveTextContent('Unverified');
  });

  it('the badge reads "Verified by Chia" when every resource verified', async () => {
    mockLedger(
      { capsule: null, verification: null, group: { passed: [], failed: [], passedCount: 0, failedCount: 0, total: 0, allPassed: false, empty: true }, entries: [] },
      verifyLedger({
        resources: [
          { resourceKey: 'index.html', source: 'local', verified: true, root: 'bb'.repeat(32), proof: { leafHash: '00'.repeat(32), siblings: [], leafIndex: 0, proofRoot: 'bb'.repeat(32) } },
        ],
      }),
    );
    renderWithProviders(<ShieldTab />);
    expect(await screen.findByTestId('verify-badge')).toHaveTextContent('Verified by Chia');
  });

  it('clicking the badge opens the proof-inspection modal', async () => {
    mockLedger(
      { capsule: null, verification: null, group: { passed: [], failed: [], passedCount: 0, failedCount: 0, total: 0, allPassed: false, empty: true }, entries: [] },
      verifyLedger(),
    );
    renderWithProviders(<ShieldTab />);
    fireEvent.click(await screen.findByTestId('verify-badge'));
    expect(await screen.findByTestId('verify-modal')).toBeInTheDocument();
    expect(screen.getAllByTestId('verify-resource').length).toBeGreaterThan(0);
  });
});
