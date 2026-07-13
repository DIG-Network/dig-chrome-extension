import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import { CredentialForm } from '@/features/security/CredentialForm';
import { qrSvg } from '@/lib/qr';
import { PASSKEY_AVAILABLE, type AuthStatus, type AuthCredential, type TotpEnrollment } from '@/lib/node-auth';
import { useEnrollTotpMutation, useSetAuthMethodMutation, useUnlockMutation } from '@/features/security/securityApi';

/** The section's local flow: pick/manage the method, enroll TOTP, verify the new authenticator, reset. */
type Flow = 'idle' | 'enrolling' | 'enrolled' | 'resetting';

/**
 * Choose/enroll the unlock authentication method (SPEC §18.24, #433). One method is active at a time,
 * layered on the per-wallet password:
 *
 * - **password (default).**
 * - **TOTP (authenticator app):** enroll generates a node-level secret (re-verifying the CURRENT
 *   factor first), shows the QR + manual-entry secret ONCE, then a real end-to-end VERIFY (an
 *   `auth.unlock` with the new code) proves the authenticator before it is relied on.
 * - **passkey:** node WebAuthn verify is DEFERRED ({@link PASSKEY_AVAILABLE} = false) — shown as a
 *   DISABLED "coming soon" option, never a broken button.
 *
 * Enrolling/replacing/resetting always re-verifies the current factor (the node enforces this; the UI
 * collects it via {@link CredentialForm}). The one-time secret is rendered but never persisted.
 */
export function AuthMethodSection({ status }: { status: AuthStatus }) {
  const [enrollTotp, enrollState] = useEnrollTotpMutation();
  const [setMethod, setMethodState] = useSetAuthMethodMutation();
  const [unlock, unlockState] = useUnlockMutation();
  const [flow, setFlow] = useState<Flow>('idle');
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isTotp = status.method === 'totp';

  function reset() {
    setFlow('idle');
    setEnrollment(null);
    setVerified(false);
    setError(null);
  }

  async function doEnroll(cred: AuthCredential) {
    setError(null);
    const res = await enrollTotp(cred);
    if ('data' in res && res.data) {
      setEnrollment(res.data);
      setVerified(false);
      setFlow('enrolled');
    } else {
      setError('data' in res ? 'TOTP_ENROLL_EMPTY' : ((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED'));
    }
  }

  async function doVerify(cred: AuthCredential) {
    // A real end-to-end check: authenticate with the NEW code (the method is now `totp`). Success
    // proves the authenticator is provisioned; it establishes a harmless read-only session.
    setError(null);
    const res = await unlock(cred);
    if ('data' in res) {
      setVerified(true);
    } else {
      setError((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED');
    }
  }

  async function doReset(cred: AuthCredential) {
    setError(null);
    const res = await setMethod({ method: 'password', credential: cred });
    if ('data' in res) {
      reset();
    } else {
      setError((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED');
    }
  }

  return (
    <section className="dig-card" data-testid="security-method" aria-labelledby="security-method-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 className="dig-subheading" id="security-method-title" style={{ margin: 0 }}>
          <FormattedMessage id="security.method.title" />
        </h3>
        <StatusPill tone={isTotp ? 'good' : 'neutral'} testid="security-method-active">
          <FormattedMessage id={isTotp ? 'security.method.totp.label' : 'security.method.password.label'} />
        </StatusPill>
      </div>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="security.method.intro" />
      </p>

      {/* Current method + the passkey-deferred notice. */}
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <li data-testid="security-method-password" data-active={!isTotp || undefined}>
          <strong><FormattedMessage id="security.method.password.label" /></strong>
          <span className="dig-muted" style={{ display: 'block', fontSize: '0.9em' }}>
            <FormattedMessage id="security.method.password.desc" />
          </span>
        </li>
        <li data-testid="security-method-totp" data-active={isTotp || undefined}>
          <strong><FormattedMessage id="security.method.totp.label" /></strong>
          <span className="dig-muted" style={{ display: 'block', fontSize: '0.9em' }}>
            <FormattedMessage id="security.method.totp.desc" />
          </span>
        </li>
        <li data-testid="security-method-passkey" aria-disabled="true" style={{ opacity: 0.55 }}>
          <strong>
            <FormattedMessage id="security.method.passkey.label" />{' '}
            <span className="dig-pill" data-tone="neutral" data-testid="security-method-passkey-soon">
              <FormattedMessage id="security.method.comingSoon" />
            </span>
          </strong>
          <span className="dig-muted" style={{ display: 'block', fontSize: '0.9em' }}>
            <FormattedMessage id="security.method.passkey.desc" />
          </span>
        </li>
      </ul>

      {/* Actions (idle). */}
      {flow === 'idle' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="dig-btn dig-btn--primary" data-testid="security-totp-enroll" onClick={() => { setError(null); setFlow('enrolling'); }}>
            <FormattedMessage id={isTotp ? 'security.method.totp.replace' : 'security.method.totp.enroll'} />
          </button>
          {isTotp && (
            <button type="button" className="dig-btn" data-testid="security-method-reset" onClick={() => { setError(null); setFlow('resetting'); }}>
              <FormattedMessage id="security.method.reset" />
            </button>
          )}
          {/* Passkey is deferred — the affordance is present but disabled (never a broken button). */}
          <button type="button" className="dig-btn" data-testid="security-passkey-enroll" disabled={!PASSKEY_AVAILABLE} aria-disabled={!PASSKEY_AVAILABLE}>
            <FormattedMessage id="security.method.passkey.enroll" />
          </button>
        </div>
      )}

      {/* Enroll: re-verify the CURRENT factor, then the node mints a new secret. */}
      {flow === 'enrolling' && (
        <div data-testid="security-totp-enroll-form" style={{ marginTop: 8 }}>
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="security.method.totp.enrollIntro" />
          </p>
          <CredentialForm
            needTotp={isTotp}
            submitId={enrollState.isLoading ? 'security.method.totp.enrolling' : 'security.method.totp.enrollSubmit'}
            busy={enrollState.isLoading}
            error={error}
            onSubmit={doEnroll}
            onCancel={reset}
            testid="security-totp-enroll-cred"
          />
        </div>
      )}

      {/* Enrolled: show the QR + manual secret ONCE, then verify the new authenticator end-to-end. */}
      {flow === 'enrolled' && enrollment && (
        <div data-testid="security-totp-provision" style={{ marginTop: 8 }}>
          <p style={{ marginTop: 0 }}>
            <FormattedMessage id="security.method.totp.scan" />
          </p>
          <div
            data-testid="security-totp-qr"
            role="img"
            aria-label="TOTP enrollment QR code"
            style={{ background: '#fff', padding: 8, width: 'fit-content', borderRadius: 8 }}
            dangerouslySetInnerHTML={{ __html: qrSvg(enrollment.otpauthUri, 180) }}
          />
          <p className="dig-muted" style={{ marginBottom: 4 }}>
            <FormattedMessage id="security.method.totp.manual" />
          </p>
          <code data-testid="security-totp-secret" className="dig-mono" style={{ wordBreak: 'break-all', display: 'block', marginBottom: 8 }}>
            {enrollment.secretBase32}
          </code>

          {verified ? (
            <p className="dig-state" data-state="success" role="status" data-testid="security-totp-verified">
              <FormattedMessage id="security.method.totp.verified" />
            </p>
          ) : (
            <div data-testid="security-totp-verify-form">
              <p className="dig-muted" style={{ marginTop: 0 }}>
                <FormattedMessage id="security.method.totp.verifyIntro" />
              </p>
              <CredentialForm
                needTotp
                submitId={unlockState.isLoading ? 'security.method.totp.verifying' : 'security.method.totp.verify'}
                busy={unlockState.isLoading}
                error={error}
                onSubmit={doVerify}
                testid="security-totp-verify"
              />
            </div>
          )}
          <button type="button" className="dig-btn dig-btn--block" data-testid="security-totp-done" onClick={reset} style={{ marginTop: 8 }}>
            <FormattedMessage id="security.done" />
          </button>
        </div>
      )}

      {/* Reset to password-only: re-verify the current factor (password + current code). */}
      {flow === 'resetting' && (
        <div data-testid="security-method-reset-form" style={{ marginTop: 8 }}>
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="security.method.resetIntro" />
          </p>
          <CredentialForm
            needTotp={isTotp}
            submitId={setMethodState.isLoading ? 'security.method.resetting' : 'security.method.resetSubmit'}
            busy={setMethodState.isLoading}
            error={error}
            onSubmit={doReset}
            onCancel={reset}
            testid="security-method-reset-cred"
          />
        </div>
      )}
    </section>
  );
}
