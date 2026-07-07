import type { AssetBalance } from '@/features/wallet/assetTypes';

/** The hero balance shown at the top of Home. */
export interface HeroBalance {
  amountLabel: string;
  ticker: string;
  /** The raw asset row backing this pick (for USD conversion, #156), or null when none is known. */
  asset: AssetBalance | null;
}

/**
 * Pick the hero balance for the portfolio header. The honest hero is the XCH balance (the native
 * unit), falling back to the first asset with a known balance, else an em dash. Pure + unit-tested.
 * Carries its own `asset` row so a caller can compute its USD value (`assetUsdValue`) without this
 * module needing a price-map dependency — a full multi-asset fiat TOTAL is a separate concern
 * (`portfolioValue`); this is the single hero asset's own native ⇄ fiat pair (#156).
 */
export function pickHeroBalance(balances: AssetBalance[] | undefined): HeroBalance {
  const rows = balances ?? [];
  const xch = rows.find((r) => r.descriptor.key === 'xch');
  if (xch && xch.balance != null) return { amountLabel: xch.label, ticker: xch.descriptor.ticker, asset: xch };
  const known = rows.find((r) => r.balance != null);
  if (known) return { amountLabel: known.label, ticker: known.descriptor.ticker, asset: known };
  return { amountLabel: '—', ticker: xch?.descriptor.ticker ?? 'XCH', asset: null };
}

/** True when a balances result has no asset carrying a known (non-null) balance. */
export function balancesAreEmpty(balances: AssetBalance[] | undefined): boolean {
  const rows = balances ?? [];
  return rows.length === 0 || rows.every((r) => r.balance == null || r.balance === 0);
}
