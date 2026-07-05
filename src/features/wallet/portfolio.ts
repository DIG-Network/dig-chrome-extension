import type { AssetBalance } from '@/features/wallet/walletApi';

/** The hero balance shown at the top of Home. */
export interface HeroBalance {
  amountLabel: string;
  ticker: string;
}

/**
 * Pick the hero balance for the portfolio header. Phase 0 has no price feed, so a fiat "total"
 * can't be computed across assets — the honest hero is the XCH balance (the native unit), falling
 * back to the first asset with a known balance, else an em dash. Pure + unit-tested.
 */
export function pickHeroBalance(balances: AssetBalance[] | undefined): HeroBalance {
  const rows = balances ?? [];
  const xch = rows.find((r) => r.descriptor.key === 'xch');
  if (xch && xch.balance != null) return { amountLabel: xch.label, ticker: xch.descriptor.ticker };
  const known = rows.find((r) => r.balance != null);
  if (known) return { amountLabel: known.label, ticker: known.descriptor.ticker };
  return { amountLabel: '—', ticker: xch?.descriptor.ticker ?? 'XCH' };
}

/** True when a balances result has no asset carrying a known (non-null) balance. */
export function balancesAreEmpty(balances: AssetBalance[] | undefined): boolean {
  const rows = balances ?? [];
  return rows.length === 0 || rows.every((r) => r.balance == null || r.balance === 0);
}
