import type { AssetDescriptor } from '@/lib/wallet-assets';

/**
 * One asset row shared across the wallet UI: an asset's descriptor + its raw balance (base units)
 * + a display label. Lives in its own leaf (no transport / RTK-Query dependency) so the custody
 * views (`custody/balances`, `SendPanel`, `TradePanel`) and `portfolio` selectors can share the
 * shape without importing a data-layer module.
 */
export interface AssetBalance {
  descriptor: AssetDescriptor;
  /** Balance in base units, or null when unavailable (never a false 0). */
  balance: number | null;
  /** Display label (crypto amount, trailing zeros trimmed) or an em dash. */
  label: string;
}
