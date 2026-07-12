import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { inclusionProofDisplay } from '@/lib/dig-ledger';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { useGetShieldLedgerQuery, useGetVerifyLedgerQuery } from '@/features/shield/shieldApi';
import { VerifyModal } from '@/features/shield/VerifyModal';

/**
 * The Shield tab (DIG Shields #134) — the active tab's capsule + per-resource inclusion-proof
 * verdicts, grouped verified/failed with an aggregate. Reuses the pure `dig-ledger` model + the
 * background `getShieldLedger` query; never re-verifies (fail-closed by construction). Four states.
 *
 * #307: headlines the panel with the AUTHORITATIVE server-side "Verified by Chia" badge from the
 * local dig-node's `/verify` ledger — green only when every resource verified; "Unverified" when
 * any RPC-loaded resource failed. Clicking the badge opens the proof-inspection modal (per-resource
 * verdicts + Merkle proof data + client re-verification). Below it, the loader's own per-resource
 * ledger stays as the quick verified/failed list.
 */
export function ShieldTab() {
  // The per-tab ledger accrues entries as resources load, and OTHER surfaces (the Home creator-tip
  // prompt, #379) now also subscribe to `getShieldLedger` — so a cached empty result could predate
  // the entries this tab recorded. Always refetch on mount so the panel reflects the CURRENT ledger.
  const ledger = useGetShieldLedgerQuery(undefined, { refetchOnMountOrArgChange: true });
  const data = ledger.data;
  const group = data?.group;
  const empty = !ledger.isLoading && !ledger.isError && (!group || group.empty);

  // The server-side verification ledger (node `/verify`). Refetch on mount for the same freshness
  // reason. When no local node is reachable this errors — the badge then reads "Verification
  // details" and the modal explains the requirement honestly (reads still work; inspection needs
  // the node).
  const verify = useGetVerifyLedgerQuery(undefined, { refetchOnMountOrArgChange: true });
  const [modalOpen, setModalOpen] = useState(false);
  const verifyReady = !verify.isLoading;
  const verified = verify.data?.aggregate.verified === true;
  const badgeTone = verify.isError ? 'neutral' : verified ? 'good' : 'bad';
  const badgeId = verify.isError
    ? 'verify.badge.details'
    : verified
      ? 'verify.badge.verified'
      : 'verify.badge.unverified';

  return (
    <section className="dig-card" data-testid="shield-panel" aria-labelledby="shield-title">
      <h2 className="dig-heading" id="shield-title">
        <FormattedMessage id="shield.title" />
      </h2>

      {/* Authoritative chain-verification badge → opens the proof-inspection modal (#307). */}
      {verifyReady && (
        <div style={{ margin: '4px 0 12px' }}>
          <button
            type="button"
            data-testid="verify-badge"
            aria-haspopup="dialog"
            onClick={() => setModalOpen(true)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <StatusPill tone={badgeTone}>
              <FormattedMessage id={badgeId} />
            </StatusPill>
          </button>
        </div>
      )}
      {modalOpen && (
        <VerifyModal
          ledger={verify.data}
          isLoading={verify.isLoading}
          isError={verify.isError}
          onRetry={() => void verify.refetch()}
          onClose={() => setModalOpen(false)}
        />
      )}

      <FourState
        isLoading={ledger.isLoading}
        isError={ledger.isError}
        isEmpty={empty}
        onRetry={() => void ledger.refetch()}
        loadingId="shield.loading"
        emptyId="shield.empty"
        testid="shield"
      >
        {data && group && (
          <div>
            {data.capsule && (
              <p className="dig-muted" data-testid="shield-capsule">
                <FormattedMessage id="shield.capsule" />:{' '}
                <span className="dig-mono">
                  {data.capsule.storeId.slice(0, 10)}…:{data.capsule.rootHash.slice(0, 10)}…
                </span>
              </p>
            )}
            <div style={{ margin: '10px 0' }}>
              <StatusPill tone={group.allPassed ? 'good' : 'bad'} testid="shield-verdict">
                <FormattedMessage id={group.allPassed ? 'shield.allPassed' : 'shield.someFailed'} />
              </StatusPill>
            </div>
            <div className="dig-section-title">
              <FormattedMessage id="shield.verified" values={{ count: group.passedCount }} />
            </div>
            {group.passed.map((e) => {
              const d = inclusionProofDisplay(e);
              return (
                <div className="dig-row" key={`p-${e.resourcePath}`} data-testid="shield-passed-item">
                  <span aria-hidden="true">✓</span>
                  <div className="dig-row-main">
                    <div className="dig-mono">{e.resourcePath}</div>
                    <div className="dig-muted">{d.label}</div>
                  </div>
                </div>
              );
            })}
            {group.failedCount > 0 && (
              <>
                <div className="dig-section-title" style={{ marginTop: 12 }}>
                  <FormattedMessage id="shield.failed" values={{ count: group.failedCount }} />
                </div>
                {group.failed.map((e) => (
                  <div className="dig-row" key={`f-${e.resourcePath}`} data-testid="shield-failed-item">
                    <span aria-hidden="true">✕</span>
                    <div className="dig-row-main">
                      <div className="dig-mono">{e.resourcePath}</div>
                      <div className="dig-muted">{e.errorCode || 'DIG_ERR_PROOF_MISMATCH'}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </FourState>
    </section>
  );
}
