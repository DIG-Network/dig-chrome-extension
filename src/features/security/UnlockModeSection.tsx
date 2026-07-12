import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { CredentialForm } from '@/features/security/CredentialForm';
import { modeChangeNeedsCredential, type AuthStatus, type AuthCredential, type UnlockMode } from '@/lib/node-auth';
import { useSetAuthModeMutation } from '@/features/security/securityApi';

/**
 * The unlock-mode toggle (SPEC §18.24, #433) — the ONE policy knob. Honest, no dark pattern (§6.0):
 * each option states plainly what it trades.
 *
 * - **per_transaction (DEFAULT, secure):** the session unlock is READ-ONLY; every signature needs a
 *   fresh unlock, so the decrypted key never lingers in the node between signatures.
 * - **session_unlock_all (convenience, OFF by default):** one unlock covers all signing for the
 *   session; the key stays decrypted for the session. Switching INTO it WEAKENS the posture, so the
 *   node re-verifies the CURRENT factor first ({@link modeChangeNeedsCredential}). Tightening back to
 *   per_transaction needs no credential.
 */
export function UnlockModeSection({ status }: { status: AuthStatus }) {
  const [setMode, setModeState] = useSetAuthModeMutation();
  const [pendingMode, setPendingMode] = useState<UnlockMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply(target: UnlockMode, credential?: AuthCredential) {
    setError(null);
    const res = await setMode({ mode: target, ...(credential ? { credential } : {}) });
    if ('data' in res) {
      setPendingMode(null);
    } else {
      setError((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED');
    }
  }

  function choose(target: UnlockMode) {
    if (target === status.mode) return;
    if (modeChangeNeedsCredential(target)) {
      // Switching to session_unlock_all WEAKENS → collect the current factor before applying.
      setPendingMode(target);
      setError(null);
    } else {
      void apply(target);
    }
  }

  const options: { mode: UnlockMode; labelId: string; descId: string; testid: string }[] = [
    { mode: 'per_transaction', labelId: 'security.mode.perTx.label', descId: 'security.mode.perTx.desc', testid: 'security-mode-per-transaction' },
    { mode: 'session_unlock_all', labelId: 'security.mode.session.label', descId: 'security.mode.session.desc', testid: 'security-mode-session-all' },
  ];

  return (
    <section className="dig-card" data-testid="security-mode" aria-labelledby="security-mode-title">
      <h3 className="dig-subheading" id="security-mode-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="security.mode.title" />
      </h3>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="security.mode.intro" />
      </p>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <legend className="dig-visually-hidden">
          <FormattedMessage id="security.mode.title" />
        </legend>
        {options.map((o) => (
          <label key={o.mode} className="dig-radio-card" data-testid={o.testid} data-selected={status.mode === o.mode || undefined} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="security-unlock-mode"
              className="dig-radio"
              data-testid={`${o.testid}-input`}
              checked={status.mode === o.mode}
              disabled={setModeState.isLoading}
              onChange={() => choose(o.mode)}
            />
            <span>
              <strong>
                <FormattedMessage id={o.labelId} />
              </strong>
              <span className="dig-muted" style={{ display: 'block', fontSize: '0.9em' }}>
                <FormattedMessage id={o.descId} />
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Switching to session_unlock_all re-verifies the current factor before it weakens the posture. */}
      {pendingMode === 'session_unlock_all' && (
        <div data-testid="security-mode-confirm" style={{ marginTop: 10 }}>
          <p className="dig-state" data-state="warn" role="alert" data-testid="security-mode-warning" style={{ marginTop: 0 }}>
            <FormattedMessage id="security.mode.session.confirm" />
          </p>
          <CredentialForm
            needTotp={status.method === 'totp'}
            submitId={setModeState.isLoading ? 'security.mode.applying' : 'security.mode.session.apply'}
            busy={setModeState.isLoading}
            error={error}
            onSubmit={(cred) => void apply('session_unlock_all', cred)}
            onCancel={() => {
              setPendingMode(null);
              setError(null);
            }}
            testid="security-mode-cred"
          />
        </div>
      )}
    </section>
  );
}
