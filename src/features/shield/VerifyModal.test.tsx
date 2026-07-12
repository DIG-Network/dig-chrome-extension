import { describe, it, expect } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { VerifyModal } from '@/features/shield/VerifyModal';
import { renderWithProviders } from '@/test/harness';
import type { VerifyLedger } from '@/lib/verify-ledger';

// A single resource whose proof folds (leaf 00.., right sibling 11..) to this golden root, which is
// ALSO its anchored root — so a client re-verify is fully trusted.
const GOLDEN_ROOT = 'eeeb4ecba0277be1cc99ab5a984379dc42ebe5ebb576c65535f44de80086fa4a';

const ledger = (over: Partial<VerifyLedger> = {}): VerifyLedger => ({
  storeId: 'aa'.repeat(32),
  root: GOLDEN_ROOT,
  aggregate: {
    verified: false,
    anyRpcFailed: true,
    counts: { total: 2, verified: 1, failed: 1, bySource: { local: 1, peer: 0, rpc: 1 } },
  },
  resources: [
    {
      resourceKey: 'index.html',
      source: 'local',
      verified: true,
      root: GOLDEN_ROOT,
      proof: {
        leafHash: '00'.repeat(32),
        siblings: [{ hash: '11'.repeat(32), dir: 'right' }],
        leafIndex: 0,
        proofRoot: GOLDEN_ROOT,
      },
      failReason: null,
    },
    {
      resourceKey: 'evil.js',
      source: 'rpc',
      verified: false,
      root: GOLDEN_ROOT,
      proof: { leafHash: 'ff'.repeat(32), siblings: [], leafIndex: 3, proofRoot: 'cd'.repeat(32) },
      failReason: 'DIG_ERR_PROOF_MISMATCH',
    },
  ],
  ...over,
});

const noop = () => {};

describe('VerifyModal', () => {
  it('lists per-resource verdicts with source + aggregate, and flags the RPC failure', () => {
    renderWithProviders(<VerifyModal ledger={ledger()} isLoading={false} isError={false} onRetry={noop} onClose={noop} />);
    expect(screen.getByTestId('verify-modal-aggregate')).toHaveTextContent('Unverified');
    expect(screen.getByTestId('verify-rpc-failed')).toBeInTheDocument();
    const rows = screen.getAllByTestId('verify-resource');
    expect(rows).toHaveLength(2);
    // The RPC resource surfaces the "Public network" tier + a Failed verdict.
    const evil = rows[1];
    expect(within(evil).getByTestId('verify-resource-source')).toHaveTextContent('Public network');
    expect(within(evil).getByTestId('verify-resource-verdict')).toHaveTextContent('Failed');
  });

  it('expands a resource to show its Merkle proof data (leaf, index, siblings, roots)', () => {
    renderWithProviders(<VerifyModal ledger={ledger()} isLoading={false} isError={false} onRetry={noop} onClose={noop} />);
    const toggle = screen.getAllByTestId('verify-resource-toggle')[0];
    fireEvent.click(toggle);
    const proof = screen.getByTestId('verify-proof');
    expect(within(proof).getByTestId('verify-leaf-index')).toHaveTextContent('0');
    expect(within(proof).getByTestId('verify-siblings')).toBeInTheDocument();
    // Full hashes are preserved for inspection (title attr) even though the label is truncated.
    expect(within(proof).getByTitle('00'.repeat(32))).toBeInTheDocument();
  });

  it('re-verifies a valid proof CLIENT-side and shows the trusted verdict', async () => {
    renderWithProviders(<VerifyModal ledger={ledger()} isLoading={false} isError={false} onRetry={noop} onClose={noop} />);
    fireEvent.click(screen.getAllByTestId('verify-resource-toggle')[0]);
    // The re-verify runs async (crypto.subtle); wait for the terminal trusted verdict.
    expect(await screen.findByText('Re-verified locally')).toBeInTheDocument();
  });

  it('shows the honest error copy when the node ledger is unavailable', () => {
    renderWithProviders(<VerifyModal isLoading={false} isError onRetry={noop} onClose={noop} />);
    expect(screen.getByTestId('verify-error')).toHaveTextContent('local DIG node');
  });

  it('shows the empty state when the node served nothing for this page', () => {
    const empty = ledger({ resources: [], aggregate: { verified: false, anyRpcFailed: false, counts: { total: 0, verified: 0, failed: 0, bySource: { local: 0, peer: 0, rpc: 0 } } } });
    renderWithProviders(<VerifyModal ledger={empty} isLoading={false} isError={false} onRetry={noop} onClose={noop} />);
    expect(screen.getByTestId('verify-empty')).toBeInTheDocument();
  });
});
