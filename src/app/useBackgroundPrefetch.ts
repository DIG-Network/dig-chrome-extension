import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/app/hooks';
import { useGetLockStateQuery, custodyApi } from '@/features/wallet/custodyApi';
import { collectiblesApi } from '@/features/collectibles/collectiblesApi';
import { catMetadataApi } from '@/features/wallet/catMetadataApi';
import { prefetchContextKey, runPrefetchSequence, type PrefetchContext } from '@/app/backgroundPrefetch';

/**
 * #168 — background prefetch: as soon as the wallet is unlocked, and again whenever the active
 * wallet or derivation index changes while unlocked (#90/#165/#162), proactively warm the RTK Query
 * cache for the views a user is most likely to open next — balances, CAT/asset metadata,
 * collectibles, then the local activity log (§18.5a) — so opening Assets or Collectibles renders
 * instantly instead of a fresh spinner-then-load on nav.
 *
 * Mounted ONCE at the app shell (`Shell` in `App.tsx`) so it runs regardless of which tab/view is
 * currently showing: the mobile-OS Home tab doesn't mount the wallet body at all, and Collectibles
 * isn't mounted until the user picks that segmented tab — this hook is what actually gets ahead of
 * both. `useGetLockStateQuery()` here shares the SAME cache entry as every other caller (CustodyGate,
 * IndexNavigator, …), so mounting it a second time here costs no extra network round-trip.
 *
 * **Single-index scope (#165) is structural, not a runtime check:** every dispatched query below
 * takes NO index argument at all — the SW resolves `activeDerivationIndex()` itself from the
 * registry — so there is no parameter this hook could vary to sweep multiple indexes even by
 * accident. One context change ⇒ exactly one round of four calls.
 *
 * **Cancellable, no stale writes:** a generation counter (the same compare-and-swap discipline #155
 * uses for the auto-lock renewal window) is bumped on every new context, and
 * {@link runPrefetchSequence} checks it before every step, so a superseded run stops issuing NEW
 * steps immediately. An already-in-flight step from a superseded context can still resolve late, but
 * every wallet/index-switch mutation already resets the WHOLE `api` cache on success
 * (`resetCacheOnIdentityChange`, `custodyApi.ts`) — RTK Query only ever applies a fulfilled result to
 * a cache entry that still exists, so that late write becomes a no-op.
 */
export function useBackgroundPrefetch(): void {
  const dispatch = useAppDispatch();
  const { data } = useGetLockStateQuery();
  const generationRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  const lockState = data?.lockState;
  const walletId = data?.activeWalletId ?? null;
  const activeIndex = data?.activeIndex ?? 0;

  useEffect(() => {
    if (lockState !== 'unlocked') {
      // Locked (or not yet known): reset the dedupe key so the NEXT unlock — even for the exact
      // same wallet+index — runs a fresh prefetch round.
      lastKeyRef.current = null;
      return;
    }

    const ctx: PrefetchContext = { walletId, index: activeIndex };
    const key = prefetchContextKey(ctx);
    if (key === lastKeyRef.current) return; // already warmed this exact context
    lastKeyRef.current = key;

    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const isCurrent = () => generationRef.current === myGeneration;

    // Order: balances → assets/CAT-meta → collectibles/NFTs → activity — likely-first-viewed first.
    void runPrefetchSequence(
      [
        () => dispatch(custodyApi.endpoints.getCustodyBalances.initiate()),
        () => dispatch(catMetadataApi.endpoints.getCatRegistry.initiate()),
        () => dispatch(collectiblesApi.endpoints.listCollectibles.initiate()),
        () => dispatch(custodyApi.endpoints.getCustodyActivity.initiate()),
      ],
      isCurrent,
    );
  }, [lockState, walletId, activeIndex, dispatch]);
}
