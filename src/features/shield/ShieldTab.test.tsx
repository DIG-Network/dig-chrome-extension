import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ShieldTab } from '@/features/shield/ShieldTab';
import { renderWithProviders } from '@/test/harness';
import { ACTIONS } from '@/lib/messages';

function mockLedger(payload: unknown) {
  chrome.runtime.sendMessage = vi.fn((msg: { action: string }, cb?: (r: unknown) => void) => {
    cb?.(msg.action === ACTIONS.getShieldLedger ? payload : { success: true });
  }) as never;
}

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
});
