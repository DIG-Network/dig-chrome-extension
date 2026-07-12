import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { isTotpCode, type AuthCredential } from '@/lib/node-auth';

/** Props for the shared credential collector. */
export interface CredentialFormProps {
  /** Whether the active method needs a live node-level TOTP code alongside the password. */
  needTotp: boolean;
  /** Message id for the submit button's label (the caller swaps it for a busy label). */
  submitId: string;
  /** True while the credential is being verified by the node. */
  busy: boolean;
  /** A recoverable credential error (wrong password / code / node 401), or null. */
  error: string | null;
  /** Receive the collected credential (password + optional TOTP code). */
  onSubmit: (cred: AuthCredential) => void;
  /** Optional cancel affordance. */
  onCancel?: () => void;
  /** Message id for the cancel label (defaults to the generic cancel). */
  cancelId?: string;
  /** Stable test-hook prefix (`<testid>-password` / `-totp` / `-submit` / `-cancel` / `-error`). */
  testid: string;
}

/**
 * The reusable current-factor collector (SPEC §18.24): the target wallet's password plus — when the
 * active method is `totp` — the current node-level 6-digit code. Used by every place the Security
 * surface must present the CURRENT factor: unlocking a session, switching to `session_unlock_all`,
 * enrolling/replacing a factor, and the per-transaction sign prompt. The secret lives ONLY in this
 * component's local state for the lifetime of the form and is never persisted or logged.
 */
export function CredentialForm({ needTotp, submitId, busy, error, onSubmit, onCancel, cancelId = 'security.cancel', testid }: CredentialFormProps) {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const canSubmit = password.length > 0 && (!needTotp || isTotpCode(totpCode)) && !busy;

  return (
    <form
      data-testid={`${testid}-form`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit(needTotp ? { password, totpCode } : { password });
      }}
    >
      <label className="dig-field">
        <span>
          <FormattedMessage id="security.field.password" />
        </span>
        <input
          data-testid={`${testid}-password`}
          className="dig-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {needTotp && (
        <label className="dig-field">
          <span>
            <FormattedMessage id="security.field.totp" />
          </span>
          <input
            data-testid={`${testid}-totp`}
            className="dig-input dig-mono"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>
      )}
      {error && (
        <p className="dig-error-text" role="alert" data-testid={`${testid}-error`} style={{ margin: '4px 0' }}>
          <FormattedMessage id="security.error.credential" />
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" className="dig-btn dig-btn--primary" style={{ flex: 1 }} data-testid={`${testid}-submit`} disabled={!canSubmit}>
          <FormattedMessage id={submitId} />
        </button>
        {onCancel && (
          <button type="button" className="dig-btn" style={{ flex: 1 }} data-testid={`${testid}-cancel`} onClick={onCancel} disabled={busy}>
            <FormattedMessage id={cancelId} />
          </button>
        )}
      </div>
    </form>
  );
}
