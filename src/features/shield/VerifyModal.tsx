import { useEffect, useId, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Sheet } from '@/components/Sheet';
import { StatusPill } from '@/components/StatusPill';
import { FourState } from '@/components/FourState';
import { reverifyProof, type VerifyLedger, type VerifyResource, type VerifySource } from '@/lib/verify-ledger';

/** Map a serve tier to its react-intl label id. */
const SOURCE_ID: Record<VerifySource, string> = {
  local: 'verify.source.local',
  peer: 'verify.source.peer',
  rpc: 'verify.source.rpc',
};

/** Truncated 64-hex for display (keeps the modal narrow; full value stays in the DOM title). */
function shortHex(h: string): string {
  return h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

/** One monospace `label: value` proof field with the full hash available on hover/inspection. */
function ProofField({ labelId, value }: { labelId: string; value: string }) {
  return (
    <div className="dig-row" style={{ alignItems: 'baseline', gap: 8 }}>
      <span className="dig-muted" style={{ minWidth: 90 }}>
        <FormattedMessage id={labelId} />
      </span>
      <span className="dig-mono" title={value} style={{ wordBreak: 'break-all' }}>
        {value ? shortHex(value) : '—'}
      </span>
    </div>
  );
}

type Reverify = 'checking' | 'ok' | 'fail';

/**
 * One resource row: a keyboard-operable disclosure button (source + verdict) that expands to the
 * Merkle inclusion proof (leaf hash, ordered sibling path + directions, leaf index, proof root,
 * anchored root) and a CLIENT-side re-verification of that proof — folding the leaf up through the
 * siblings with the domain-separated node hash and checking it equals both the proof root AND the
 * chain-anchored root. Purely presentational; the verdict data comes from the node ledger.
 */
function VerifyResourceRow({ resource }: { resource: VerifyResource }) {
  const [open, setOpen] = useState(false);
  const [reverify, setReverify] = useState<Reverify | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setReverify('checking');
    void reverifyProof(resource.proof).then((r) => {
      if (!live) return;
      // A full local trust decision: the fold matches the proof root AND the proof root is the
      // chain-anchored root the entry served against.
      const trusted = r.ok && resource.proof.proofRoot === resource.root && resource.root.length > 0;
      setReverify(trusted ? 'ok' : 'fail');
    });
    return () => {
      live = false;
    };
    // Runs once per open (not per `reverify` change — including `reverify` would let the cleanup
    // cancel the in-flight fold). `resource` is stable for a given row.
  }, [open, resource]);

  const failed = !resource.verified;
  const siblings = resource.proof.siblings || [];

  return (
    <div className="dig-card" style={{ padding: 8, marginBottom: 6 }} data-testid="verify-resource">
      <button
        type="button"
        className="dig-row"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="verify-resource-toggle"
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', gap: 8 }}
      >
        <span aria-hidden="true">{failed ? '✕' : '✓'}</span>
        <span className="dig-row-main">
          <span className="dig-mono" style={{ wordBreak: 'break-all' }}>
            {resource.resourceKey || 'index.html'}
          </span>
        </span>
        <StatusPill tone={resource.source === 'rpc' ? 'warn' : 'neutral'} testid="verify-resource-source">
          <FormattedMessage id={SOURCE_ID[resource.source]} />
        </StatusPill>
        <StatusPill tone={failed ? 'bad' : 'good'} testid="verify-resource-verdict">
          <FormattedMessage id={failed ? 'verify.status.failed' : 'verify.status.verified'} />
        </StatusPill>
      </button>

      {open && (
        <div id={panelId} data-testid="verify-proof" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--dig-border, #333)' }}>
          {failed && resource.failReason && (
            <p className="dig-muted" data-testid="verify-fail-reason" style={{ marginTop: 0 }}>
              <FormattedMessage id="verify.reason" />: <span className="dig-mono">{resource.failReason}</span>
            </p>
          )}
          <ProofField labelId="verify.proof.leafHash" value={resource.proof.leafHash} />
          <div className="dig-row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className="dig-muted" style={{ minWidth: 90 }}>
              <FormattedMessage id="verify.proof.leafIndex" />
            </span>
            <span className="dig-mono" data-testid="verify-leaf-index">
              {resource.proof.leafIndex}
            </span>
          </div>
          <ProofField labelId="verify.proof.proofRoot" value={resource.proof.proofRoot} />
          <ProofField labelId="verify.proof.root" value={resource.root} />
          <div className="dig-section-title" style={{ marginTop: 8 }}>
            <FormattedMessage id="verify.proof.siblings" values={{ count: siblings.length }} />
          </div>
          {siblings.length === 0 ? (
            <p className="dig-muted" style={{ margin: 0 }}>
              <FormattedMessage id="verify.proof.noSiblings" />
            </p>
          ) : (
            <ol data-testid="verify-siblings" style={{ margin: 0, paddingLeft: 18 }}>
              {siblings.map((s, i) => (
                <li key={`${s.dir}-${i}-${s.hash}`} className="dig-mono" style={{ wordBreak: 'break-all' }}>
                  <span className="dig-muted">
                    <FormattedMessage id={s.dir === 'left' ? 'verify.sibling.left' : 'verify.sibling.right'} />
                  </span>{' '}
                  <span title={s.hash}>{shortHex(s.hash)}</span>
                </li>
              ))}
            </ol>
          )}
          <div style={{ marginTop: 8 }} aria-live="polite">
            {reverify === 'checking' && (
              <span className="dig-muted" data-testid="verify-reverify">
                <FormattedMessage id="verify.reverify.checking" />
              </span>
            )}
            {reverify === 'ok' && (
              <StatusPill tone="good" testid="verify-reverify">
                <FormattedMessage id="verify.reverify.ok" />
              </StatusPill>
            )}
            {reverify === 'fail' && (
              <StatusPill tone="bad" testid="verify-reverify">
                <FormattedMessage id="verify.reverify.fail" />
              </StatusPill>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The proof-inspection modal (#307): lists every resource the local dig-node served for the active
 * page with its server-side verdict (source local | peer | public network, verified/failed +
 * reason), and lets the user open each resource's full Merkle inclusion proof — with an independent
 * client-side re-verification. Presentational: the parent owns the `getVerifyLedger` query and
 * passes its state in, so this renders the four async states (loading / error / empty / success)
 * without fetching itself. The ledger is a LOCAL-node-only surface — the error copy says so.
 */
export function VerifyModal({
  ledger,
  isLoading,
  isError,
  onRetry,
  onClose,
}: {
  ledger?: VerifyLedger;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const resources = ledger?.resources ?? [];
  const isEmpty = !isLoading && !isError && resources.length === 0;
  const agg = ledger?.aggregate;

  return (
    <Sheet title={intl.formatMessage({ id: 'verify.modal.title' })} onClose={onClose} testid="verify-modal">
      <FourState
        isLoading={isLoading}
        isError={isError}
        isEmpty={isEmpty}
        onRetry={onRetry}
        loadingId="shield.loading"
        errorId="verify.error"
        emptyId="verify.empty"
        testid="verify"
      >
        {agg && (
          <div>
            <div style={{ marginBottom: 10 }}>
              <StatusPill tone={agg.verified ? 'good' : 'bad'} testid="verify-modal-aggregate">
                <FormattedMessage id={agg.verified ? 'verify.badge.verified' : 'verify.badge.unverified'} />
              </StatusPill>{' '}
              <span className="dig-muted" data-testid="verify-summary">
                <FormattedMessage
                  id="verify.summary"
                  values={{ verified: agg.counts.verified, total: agg.counts.total }}
                />
              </span>
            </div>
            {agg.anyRpcFailed && (
              <p className="dig-muted" data-testid="verify-rpc-failed" style={{ marginTop: 0 }}>
                <FormattedMessage id="verify.rpcFailed" />
              </p>
            )}
            {resources.map((r) => (
              <VerifyResourceRow key={r.resourceKey} resource={r} />
            ))}
          </div>
        )}
      </FourState>
    </Sheet>
  );
}
