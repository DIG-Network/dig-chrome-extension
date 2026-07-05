import { useEffect, useState, type ReactNode } from 'react';
import { FourState } from '@/components/FourState';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useAppDispatch } from '@/app/hooks';
import { custodyStateHydrated } from '@/features/wallet/walletSlice';
import { useGetLockStateQuery } from '@/features/wallet/custodyApi';
import { Onboarding } from '@/features/wallet/custody/Onboarding';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { NoWalletCard } from '@/features/wallet/custody/NoWalletCard';

/**
 * The self-custody landing gate (Fable landing matrix, custody tiers). Reads the SW's authoritative
 * lock state and decides what the wallet surface shows BEFORE the balances view:
 *   - loading (first read)     → a skeleton (cached-first once the slice mirror exists)
 *   - no wallet, fullscreen    → the full Onboarding flow (Fable: onboarding lives in fullscreen)
 *   - no wallet, popup/compact → a one-card CTA that opens fullscreen onboarding
 *   - locked                   → the UnlockScreen
 *   - unlocked                 → the wallet ({children})
 * A "use Sage instead" escape falls through to {children} so the WalletConnect broker path stays
 * reachable (custody is PRIMARY, Sage secondary). Approval-preempt + route-resume tiers layer on in
 * later PRs (they need the approval window / route memory).
 */
export function CustodyGate({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const isWide = useMediaQuery('(min-width: 960px)');
  const { data, isLoading, isError, refetch } = useGetLockStateQuery();
  const [onboardingActive, setOnboardingActive] = useState(false);
  const [useSage, setUseSage] = useState(false);

  const lockState = data?.lockState;

  useEffect(() => {
    if (data) dispatch(custodyStateHydrated(data));
  }, [data, dispatch]);

  // Enter the fullscreen onboarding flow once we confirm there's no wallet (and the user hasn't
  // chosen the Sage path). Staying `active` keeps the reveal/confirm steps mounted even after
  // create unlocks the wallet mid-flow.
  useEffect(() => {
    if (lockState === 'none' && isWide && !useSage) setOnboardingActive(true);
  }, [lockState, isWide, useSage]);

  if (isLoading && !data) {
    return (
      <div data-testid="custody-gate">
        <FourState isLoading isError={false} isEmpty={false} onRetry={() => void refetch()} testid="custody-lockstate">
          {null}
        </FourState>
      </div>
    );
  }
  if (isError && !data) {
    return (
      <div data-testid="custody-gate">
        <FourState isLoading={false} isError isEmpty={false} onRetry={() => void refetch()} testid="custody-lockstate">
          {null}
        </FourState>
      </div>
    );
  }

  if (useSage) return <div data-testid="custody-gate">{children}</div>;

  let body: ReactNode;
  if (onboardingActive) {
    body = <Onboarding onDone={() => setOnboardingActive(false)} onUseSage={() => { setUseSage(true); setOnboardingActive(false); }} />;
  } else if (lockState === 'none') {
    body = <NoWalletCard onUseSage={() => setUseSage(true)} />;
  } else if (lockState === 'locked') {
    body = <UnlockScreen />;
  } else {
    body = children;
  }

  return <div data-testid="custody-gate">{body}</div>;
}
