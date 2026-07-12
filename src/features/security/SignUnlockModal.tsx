import { FormattedMessage, useIntl } from 'react-intl';
import { Sheet } from '@/components/Sheet';
import { CredentialForm } from '@/features/security/CredentialForm';
import type { AuthCredential, AuthMethod } from '@/lib/node-auth';

/** Props for the per-transaction unlock prompt. Presentational: the gate injects the handlers. */
export interface SignUnlockModalProps {
  /** Whether the prompt is shown (a signing op is waiting on a fresh unlock). */
  open: boolean;
  /** The active auth method — decides whether the TOTP code field is shown. */
  method: AuthMethod;
  /** True while `auth.sign_unlock` is in flight. */
  busy: boolean;
  /** A recoverable credential error (wrong password / TOTP code / node 401), or null. */
  error: string | null;
  /** Submit the collected credential (the gate calls `auth.sign_unlock`). */
  onSubmit: (cred: AuthCredential) => void;
  /** Dismiss without signing (the signing op is abandoned; nothing is armed). */
  onCancel: () => void;
}

/**
 * The per-transaction unlock prompt (SPEC §18.24, #431/#433). Shown BEFORE every signing operation
 * when the dig-node is the signer (#374) and a fresh unlock is required (per_transaction mode, or a
 * not-yet-unlocked session). Collects the target wallet's password plus — when the active method is
 * `totp` — the current node-level 6-digit code, and hands them to the gate, which calls
 * `auth.sign_unlock` to arm EXACTLY ONE signature. The secret is NEVER stored: it lives only in the
 * {@link CredentialForm}'s local state for the duration of the prompt and is dropped on close.
 *
 * Honest, recoverable UX (§6.4): loading (busy) + error (wrong credential — retry, don't clobber) +
 * cancel are all first-class. Built on the shared {@link Sheet} (portal + focus-trap + role=dialog +
 * Escape/backdrop, WCAG 2.2). All copy is react-intl.
 */
export function SignUnlockModal({ open, method, busy, error, onSubmit, onCancel }: SignUnlockModalProps) {
  const intl = useIntl();
  if (!open) return null;

  return (
    <Sheet title={intl.formatMessage({ id: 'security.sign.title' })} onClose={onCancel} testid="sign-unlock-modal">
      <p style={{ marginTop: 0 }}>
        <FormattedMessage id="security.sign.body" />
      </p>
      <CredentialForm
        needTotp={method === 'totp'}
        submitId={busy ? 'security.sign.authorizing' : 'security.sign.authorize'}
        cancelId="security.sign.cancel"
        busy={busy}
        error={error}
        onSubmit={onSubmit}
        onCancel={onCancel}
        testid="sign-unlock"
      />
    </Sheet>
  );
}
