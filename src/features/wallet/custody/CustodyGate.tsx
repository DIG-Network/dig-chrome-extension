import { useEffect, useState, type ReactNode } from 'react';
import { FourState } from '@/components/FourState';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { custodyStateHydrated, selectLockState } from '@/features/wallet/walletSlice';
import { useGetLockStateQuery } from '@/features/wallet/custodyApi';
import { Onboarding } from '@/features/wallet/custody/Onboarding';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { NoWalletCard } from '@/features/wallet/custody/NoWalletCard';

/**
 * The self-custody landing gate (Fable landing matrix, custody tiers). Self-custody is the ONLY
 * wallet path — the extension holds the key itself, there is no WalletConnect/Sage fallback. Reads
 * the SW's authoritative lock state and decides what the wallet surface shows BEFORE the balances view:
 *   - loading (first read)     → a skeleton (cached-first once the slice mirror exists)
 *   - no wallet, fullscreen    → the full Onboarding flow (Fable: onboarding lives in fullscreen)
 *   - no wallet, popup/compact → a one-card CTA that opens fullscreen onboarding
 *   - locked                   → the UnlockScreen
 *   - unlocked                 → the wallet ({children})
 * Approval-preempt + route-resume tiers layer on in later PRs (they need the approval window / route
 * memory).
 *
 * `lockState` prefers the LIVE query result (`data?.lockState`) and falls back to the durable
 * wallet-SLICE mirror (`selectLockState`) only while the live result is transiently absent (#162). A
 * switch/index/create/import mutation resets the WHOLE RTK Query cache so no stale wallet-scoped view
 * can show another identity's data (custodyApi.ts's `resetCacheOnIdentityChange`), which makes
 * `getLockState` itself transit uninitialized → pending for an instant — `data` disappears though the
 * REAL lock state hasn't changed. Falling back to the slice mirror (a SEPARATE reducer, unaffected by
 * the `api` slice reset) for that window keeps the gate rendering the same branch straight through it,
 * instead of hitting the top-level loading placeholder and UNMOUNTING the whole wallet body (or, mid-
 * onboarding, `Onboarding` — destroying its local step/mnemonic state right after the recovery phrase
 * was revealed). Preferring live `data` whenever it's present (rather than always reading the slice)
 * matters because the slice only updates a render AFTER `data` arrives (dispatched from an effect) —
 * reading the slice unconditionally would see one stale frame on every load, including the very first.
 */
export function CustodyGate({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const isWide = useMediaQuery('(min-width: 960px)');
  const { data, isLoading, isError, refetch } = useGetLockStateQuery();
  const [onboardingActive, setOnboardingActive] = useState(false);
  // True once we've hydrated at least once THIS mount — distinguishes the real first-ever load (show
  // the loading/error placeholder) from a later cache reset (keep rendering the last-known branch via
  // the slice fallback below; see the class doc above, #162).
  const [everHydrated, setEverHydrated] = useState(false);

  // Fall back to the slice mirror ONLY once we've hydrated at least once — the slice's default
  // ('none') must NEVER leak through as a real answer while the very first `getLockState` is still
  // in flight (that would wrongly read as "no wallet" and could latch `onboardingActive` before the
  // real state is known). Before the first hydration, an absent `data` means "not known yet", not
  // "none".
  const sliceLockState = useAppSelector(selectLockState);
  const lockState = data?.lockState ?? (everHydrated ? sliceLockState : undefined);

  useEffect(() => {
    if (data) {
      dispatch(custodyStateHydrated(data));
      setEverHydrated(true);
    }
  }, [data, dispatch]);

  // Enter the fullscreen onboarding flow once we confirm there's no wallet. Staying `active` keeps
  // the reveal/confirm steps mounted even after create unlocks the wallet mid-flow.
  useEffect(() => {
    if (lockState === 'none' && isWide) setOnboardingActive(true);
  }, [lockState, isWide]);

  if (isLoading && !everHydrated) {
    return (
      <div data-testid="custody-gate">
        <FourState isLoading isError={false} isEmpty={false} onRetry={() => void refetch()} testid="custody-lockstate">
          {null}
        </FourState>
      </div>
    );
  }
  if (isError && !everHydrated) {
    return (
      <div data-testid="custody-gate">
        <FourState isLoading={false} isError isEmpty={false} onRetry={() => void refetch()} testid="custody-lockstate">
          {null}
        </FourState>
      </div>
    );
  }

  let body: ReactNode;
  if (onboardingActive) {
    body = <Onboarding onDone={() => setOnboardingActive(false)} />;
  } else if (lockState === 'none') {
    body = <NoWalletCard />;
  } else if (lockState === 'locked') {
    body = <UnlockScreen />;
  } else {
    body = children;
  }

  return <div data-testid="custody-gate">{body}</div>;
}
