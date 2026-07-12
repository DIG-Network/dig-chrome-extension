import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { StatusPill, type PillTone } from '@/components/StatusPill';
import { CredentialForm } from '@/features/security/CredentialForm';
import { unlockView, type AuthStatus, type AuthCredential } from '@/lib/node-auth';
import { useLockMutation, useUnlockMutation } from '@/features/security/securityApi';

/** Map the derived unlock view to its status pill's tone + label + description ids. */
const VIEW_META: Record<ReturnType<typeof unlockView>, { tone: PillTone; labelId: string; descId: string }> = {
  locked: { tone: 'neutral', labelId: 'security.session.state.locked', descId: 'security.session.locked.desc' },
  'read-only': { tone: 'good', labelId: 'security.session.state.readOnly', descId: 'security.session.readOnly.desc' },
  'unlocked-session': { tone: 'warn', labelId: 'security.session.state.session', descId: 'security.session.session.desc' },
};

/**
 * The live lock/session state (SPEC §18.24, #433). Shows whether the node session is locked, unlocked
 * READ-ONLY (per_transaction — every signature still re-prompts), or unlocked for the whole session
 * (session_unlock_all). Offers Unlock (establish a session — read-only or full, per the active mode)
 * and Lock (clear the session + drop any armed grant). Presentational shell around the securityApi
 * mutations; the current factor is collected by {@link CredentialForm} and never persisted.
 */
export function SessionStateSection({ status }: { status: AuthStatus }) {
  const [lock, lockState] = useLockMutation();
  const [unlock, unlockState] = useUnlockMutation();
  const [showUnlock, setShowUnlock] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = unlockView(status);
  const meta = VIEW_META[view];
  const locked = status.state === 'locked';

  async function doUnlock(cred: AuthCredential) {
    setError(null);
    const res = await unlock(cred);
    if ('data' in res) {
      setShowUnlock(false);
    } else {
      setError((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED');
    }
  }

  return (
    <section className="dig-card" data-testid="security-session" aria-labelledby="security-session-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 className="dig-subheading" id="security-session-title" style={{ margin: 0 }}>
          <FormattedMessage id="security.session.title" />
        </h3>
        <StatusPill tone={meta.tone} testid="security-session-state">
          <FormattedMessage id={meta.labelId} />
        </StatusPill>
      </div>

      <p className="dig-muted" data-testid="security-session-desc" style={{ marginBottom: 8 }}>
        <FormattedMessage id={meta.descId} />
      </p>

      {status.signArmed && (
        <p className="dig-state" data-state="success" role="status" data-testid="security-session-armed" style={{ margin: '4px 0' }}>
          <FormattedMessage id="security.session.armed" />
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {locked && !showUnlock && (
          <button type="button" className="dig-btn dig-btn--primary" data-testid="security-unlock" onClick={() => setShowUnlock(true)}>
            <FormattedMessage id="security.session.unlock" />
          </button>
        )}
        {!locked && (
          <button type="button" className="dig-btn" data-testid="security-lock" onClick={() => void lock()} disabled={lockState.isLoading}>
            <FormattedMessage id="security.session.lock" />
          </button>
        )}
      </div>

      {locked && showUnlock && (
        <div data-testid="security-unlock-form" style={{ marginTop: 8 }}>
          <CredentialForm
            needTotp={status.method === 'totp'}
            submitId={unlockState.isLoading ? 'security.session.unlocking' : 'security.session.unlock'}
            busy={unlockState.isLoading}
            error={error}
            onSubmit={doUnlock}
            onCancel={() => {
              setShowUnlock(false);
              setError(null);
            }}
            testid="security-unlock-cred"
          />
        </div>
      )}
    </section>
  );
}
