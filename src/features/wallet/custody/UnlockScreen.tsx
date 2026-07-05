import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useUnlockWalletMutation } from '@/features/wallet/custodyApi';

/**
 * The unlock gate — shown when a wallet exists but is locked (§18.3). Password → the offscreen vault
 * runs Argon2id + AES-GCM; a wrong password surfaces the single opaque "unlock failed". On success
 * the `LockState` tag invalidation flips the gate to the wallet.
 */
export function UnlockScreen() {
  const intl = useIntl();
  const [password, setPassword] = useState('');
  const [unlock, state] = useUnlockWalletMutation();
  const error = state.isError ? intl.formatMessage({ id: 'custody.error.unlockFailed' }) : null;

  return (
    <section className="dig-card" data-testid="custody-unlock" aria-labelledby="unlock-title">
      <h2 className="dig-heading" id="unlock-title">
        <FormattedMessage id="custody.unlock.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.unlock.body" />
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void unlock({ password });
        }}
      >
        <label className="dig-field">
          <span><FormattedMessage id="custody.password" /></span>
          <input
            data-testid="unlock-password"
            className="dig-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {error && <p className="dig-error-text" role="alert" data-testid="unlock-error">{error}</p>}
        <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="unlock-submit" disabled={state.isLoading || !password}>
          <FormattedMessage id={state.isLoading ? 'custody.unlock.working' : 'custody.unlock.submit'} />
        </button>
      </form>
    </section>
  );
}
