import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { PairingSection } from '@/features/control/PairingSection';
import { controlPanelViewModel } from '@/lib/dig-control';
import { useGetControlStatusQuery } from '@/features/control/controlApi';
import { useGetAuthStatusQuery } from '@/features/security/securityApi';
import { SessionStateSection } from '@/features/security/SessionStateSection';
import { UnlockModeSection } from '@/features/security/UnlockModeSection';
import { AuthMethodSection } from '@/features/security/AuthMethodSection';

/**
 * The paired, node-dependent panel: reads the live `auth.status` (SPEC §18.24) and composes the three
 * management sections. Rendered only once the control-token pairing is established (the `auth.*`
 * surface is paired-token gated, §7.12). Owns the query's four states so a section never renders on
 * absent/stale status.
 */
function SecurityPanel() {
  const auth = useGetAuthStatusQuery();
  return (
    <FourState
      isLoading={auth.isLoading}
      isError={auth.isError}
      isEmpty={false}
      onRetry={() => void auth.refetch()}
      errorId="security.error.status"
      testid="security-auth"
    >
      {auth.data && (
        <div data-testid="security-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SessionStateSection status={auth.data} />
          <UnlockModeSection status={auth.data} />
          <AuthMethodSection status={auth.data} />
        </div>
      )}
    </FourState>
  );
}

/**
 * The fullscreen **Security tab** (#433, child of EPIC #431). The management surface over the
 * dig-node's node-managed unlock authentication (SPEC §18.24): choose/enroll the unlock method
 * (password / TOTP / passkey-deferred), toggle per-transaction unlock (DEFAULT, secure) vs
 * session-unlock-all (convenience), and see + drive the live lock/session state. The node is the LOCAL
 * auth authority + key custodian; this tab NEVER holds the key — it presents credentials to the node
 * and reads the posture.
 *
 * Fullscreen-only (§145 surface tiering) — advanced security lives fullscreen, never the compact
 * popup. Node-dependent + paired-gated: a node-offline state renders honestly (never a broken view),
 * and the sections render only once the control-token pairing is established.
 */
export function SecurityTab() {
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;
  const nodeOnline = !!vm?.nodeOnline;

  return (
    <section className="dig-card" data-testid="security-tab-panel" aria-labelledby="security-title">
      <h2 className="dig-heading" id="security-title">
        <FormattedMessage id="security.tab.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="security.tab.intro" />
      </p>

      <FourState
        isLoading={control.isLoading}
        isError={control.isError}
        isEmpty={false}
        onRetry={() => void control.refetch()}
        testid="security-control"
      >
        {nodeOnline ? (
          <PairingSection>
            <SecurityPanel />
          </PairingSection>
        ) : (
          <p className="dig-muted" data-testid="security-nodedown" style={{ margin: 0 }}>
            <FormattedMessage id="security.tab.nodeDown" />
          </p>
        )}
      </FourState>
    </section>
  );
}
