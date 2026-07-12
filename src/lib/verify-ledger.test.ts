import { describe, it, expect } from 'vitest';
import {
  deriveAggregate,
  normalizeVerifyLedger,
  reverifyProof,
  type VerifyResource,
} from '@/lib/verify-ledger';

const res = (over: Partial<VerifyResource>): VerifyResource => ({
  resourceKey: 'index.html',
  source: 'local',
  verified: true,
  root: 'aa'.repeat(32),
  proof: { leafHash: '00'.repeat(32), siblings: [], leafIndex: 0, proofRoot: 'aa'.repeat(32) },
  failReason: null,
  ...over,
});

describe('deriveAggregate', () => {
  it('is verified when every resource verified (non-empty)', () => {
    const a = deriveAggregate([res({ source: 'local' }), res({ source: 'rpc' })]);
    expect(a.verified).toBe(true);
    expect(a.anyRpcFailed).toBe(false);
    expect(a.counts).toEqual({
      total: 2,
      verified: 2,
      failed: 0,
      bySource: { local: 1, peer: 0, rpc: 1 },
    });
  });

  it('is UNVERIFIED (verified=false, anyRpcFailed=true) when an RPC resource failed', () => {
    const a = deriveAggregate([
      res({ source: 'local', verified: true }),
      res({ source: 'rpc', verified: false, failReason: 'DIG_ERR_PROOF_MISMATCH' }),
    ]);
    expect(a.verified).toBe(false);
    expect(a.anyRpcFailed).toBe(true);
    expect(a.counts.failed).toBe(1);
    expect(a.counts.bySource.rpc).toBe(1);
  });

  it('does NOT set anyRpcFailed when the failed resource was local/peer (not rpc)', () => {
    const a = deriveAggregate([res({ source: 'local', verified: false })]);
    expect(a.verified).toBe(false);
    expect(a.anyRpcFailed).toBe(false);
  });

  it('an empty ledger is NOT verified', () => {
    const a = deriveAggregate([]);
    expect(a.verified).toBe(false);
    expect(a.anyRpcFailed).toBe(false);
    expect(a.counts.total).toBe(0);
  });
});

describe('normalizeVerifyLedger', () => {
  it('lowercases hex, coerces arrays, and preserves a well-formed node aggregate', () => {
    const l = normalizeVerifyLedger({
      storeId: 'AA'.repeat(32),
      root: 'BB'.repeat(32),
      aggregate: {
        verified: true,
        anyRpcFailed: false,
        counts: { total: 1, verified: 1, failed: 0, bySource: { local: 1, peer: 0, rpc: 0 } },
      },
      resources: [
        {
          resourceKey: 'index.html',
          source: 'local',
          verified: true,
          root: 'BB'.repeat(32),
          proof: { leafHash: 'CC'.repeat(32), siblings: [{ hash: 'DD'.repeat(32), dir: 'right' }], leafIndex: 0, proofRoot: 'BB'.repeat(32) },
        },
      ],
    });
    expect(l.storeId).toBe('aa'.repeat(32));
    expect(l.resources[0].proof.leafHash).toBe('cc'.repeat(32));
    expect(l.resources[0].proof.siblings[0]).toEqual({ hash: 'dd'.repeat(32), dir: 'right' });
    expect(l.aggregate.verified).toBe(true);
  });

  it('recomputes a missing/garbage aggregate from the resources (defensive)', () => {
    const l = normalizeVerifyLedger({
      storeId: 'aa'.repeat(32),
      root: 'bb'.repeat(32),
      resources: [
        { resourceKey: 'a', source: 'rpc', verified: false, root: 'bb'.repeat(32), proof: {}, failReason: 'x' },
      ],
    });
    expect(l.aggregate.verified).toBe(false);
    expect(l.aggregate.anyRpcFailed).toBe(true);
  });

  it('tolerates a null/garbage response → empty ledger, not a throw', () => {
    const l = normalizeVerifyLedger(null);
    expect(l.resources).toEqual([]);
    expect(l.aggregate.verified).toBe(false);
  });
});

describe('reverifyProof (SHA-256("digstore:node:v1"||left||right) fold)', () => {
  it('folds a right-then-left path to the golden proofRoot', async () => {
    const r = await reverifyProof({
      leafHash: '00'.repeat(32),
      siblings: [
        { hash: '11'.repeat(32), dir: 'right' },
        { hash: '22'.repeat(32), dir: 'left' },
      ],
      leafIndex: 0,
      proofRoot: '6bbbfa025457cc39dc1374afa81989ebca13f676a5bfda3787c65f6e831de624',
    });
    expect(r.computedRoot).toBe('6bbbfa025457cc39dc1374afa81989ebca13f676a5bfda3787c65f6e831de624');
    expect(r.ok).toBe(true);
  });

  it('single right sibling matches the golden node hash', async () => {
    const r = await reverifyProof({
      leafHash: '00'.repeat(32),
      siblings: [{ hash: '11'.repeat(32), dir: 'right' }],
      leafIndex: 0,
      proofRoot: 'eeeb4ecba0277be1cc99ab5a984379dc42ebe5ebb576c65535f44de80086fa4a',
    });
    expect(r.ok).toBe(true);
  });

  it('single left sibling folds hash(sibling, acc)', async () => {
    const r = await reverifyProof({
      leafHash: '00'.repeat(32),
      siblings: [{ hash: '22'.repeat(32), dir: 'left' }],
      leafIndex: 0,
      proofRoot: '2625900199612507c4db25e91373545fdac8ce4770ec9151cff74cf2032d8fb1',
    });
    expect(r.ok).toBe(true);
  });

  it('a tampered sibling folds to a different root → ok:false', async () => {
    const r = await reverifyProof({
      leafHash: '00'.repeat(32),
      siblings: [{ hash: '99'.repeat(32), dir: 'right' }],
      leafIndex: 0,
      proofRoot: 'eeeb4ecba0277be1cc99ab5a984379dc42ebe5ebb576c65535f44de80086fa4a',
    });
    expect(r.ok).toBe(false);
  });

  it('a leaf with no siblings verifies iff leafHash === proofRoot', async () => {
    const ok = await reverifyProof({ leafHash: 'ab'.repeat(32), siblings: [], leafIndex: 0, proofRoot: 'ab'.repeat(32) });
    expect(ok.ok).toBe(true);
    const bad = await reverifyProof({ leafHash: 'ab'.repeat(32), siblings: [], leafIndex: 0, proofRoot: 'cd'.repeat(32) });
    expect(bad.ok).toBe(false);
  });
});
