import { useEffect, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { custodyStateHydrated, selectLockState, selectUnlockExpiry } from '@/features/wallet/walletSlice';
import { useGetLockStateQuery, useLockWalletMutation } from '@/features/wallet/custodyApi';
import { minutesUntilLock } from '@/lib/custody-session';

/** Poll cadence for the countdown's authoritative source (a cheap storage-only read, no vault
 * round-trip — see `getLockStateSnapshot` in `src/background/index.ts`). Also the local tick rate
 * that advances the displayed minute count between polls. */
const REFRESH_MS = 15_000;

/**
 * The visible auto-lock session status (#76 P1-4): a live "auto-locks in Xm" countdown + an
 * explicit "Lock now" action, surfaced alongside {@link AutoLockSetting} in Settings so a user can
 * SEE the session is time-bounded and end it early without hunting for the wallet switcher's own
 * lock action. Renders nothing while locked/none — there is no live session to count down.
 *
 * Polls `getLockState` (rather than trusting only the wallet slice's last hydration) so the
 * countdown reflects a renewal that happened elsewhere — a send, a balance read, another surface —
 * without this panel having to be the one driving that activity.
 */
export function SessionStatus() {
  const dispatch = useAppDispatch();
  const { data } = useGetLockStateQuery(undefined, { pollingInterval: REFRESH_MS });
  useEffect(() => {
    if (data) dispatch(custodyStateHydrated(data));
  }, [data, dispatch]);

  const lockState = useAppSelector(selectLockState);
  const unlockExpiry = useAppSelector(selectUnlockExpiry);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const [lockWallet, lockMutation] = useLockWalletMutation();

  if (lockState !== 'unlocked') return null;
  const minutes = minutesUntilLock(unlockExpiry, now);

  return (
    <div className="dig-card" data-testid="session-status">
      <p className="dig-muted" style={{ marginTop: 0 }} data-testid="session-status-countdown" role="status">
        {minutes != null ? (
          <FormattedMessage id="custody.session.remaining" values={{ minutes }} />
        ) : (
          <FormattedMessage id="custody.session.remaining.unknown" />
        )}
      </p>
      <button
        type="button"
        className="dig-btn dig-btn--block"
        data-testid="session-status-lock-now"
        disabled={lockMutation.isLoading}
        onClick={() => void lockWallet()}
      >
        <FormattedMessage id="custody.session.lockNow" />
      </button>
    </div>
  );
}
