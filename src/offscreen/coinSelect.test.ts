import { describe, it, expect, vi } from 'vitest';
import type { Coin, PaymentAsset, SelectCoinsResult } from '@dignetwork/chip35-dl-coin-wasm';
import {
  COIN_CAP,
  selectSpendCoins,
  NeedsConsolidationError,
  InsufficientFundsError,
  isNeedsConsolidationError,
  isInsufficientFundsError,
} from '@/offscreen/coinSelect';

/** A rich candidate: an id-bearing wrapper around an on-chain Coin (stands in for a ChainCoin/Cat). */
interface Candidate {
  label: string;
  coin: Coin;
}
const XCH: PaymentAsset = { xch: true };
const b = (n: number) => Uint8Array.from([n]);
const mk = (label: string, amount: bigint, parent = 1, puzzle = 2): Candidate => ({
  label,
  coin: { parentCoinInfo: b(parent), puzzleHash: b(puzzle), amount },
});
const coinOf = (c: Candidate) => c.coin;

describe('selectSpendCoins (#417)', () => {
  it('maps the wasm-chosen coins back to candidates, largest-first, with totals', () => {
    const big = mk('big', 100n, 1, 1);
    const small = mk('small', 10n, 2, 2);
    const select = vi.fn(
      (): SelectCoinsResult => ({ ok: true, coins: [big.coin, small.coin], total: 110n, change: 10n, coinCount: 2, asset: XCH }),
    );
    const out = selectSpendCoins({ candidates: [small, big], target: 100n, asset: XCH, coinOf, select });
    expect(out.selected.map((c) => c.label)).toEqual(['big', 'small']); // preserves wasm order
    expect(out.total).toBe(110n);
    expect(out.change).toBe(10n);
    expect(select).toHaveBeenCalledWith([small.coin, big.coin], 100n, XCH, COIN_CAP);
  });

  it('maps duplicate-amount coins each to a distinct candidate (consume-once)', () => {
    const a = mk('a', 5n, 1, 9);
    const dup = mk('b', 5n, 1, 9); // identical identity fields → same coinKey
    const select = (): SelectCoinsResult => ({ ok: true, coins: [a.coin, dup.coin], total: 10n, change: 0n, coinCount: 2, asset: XCH });
    const out = selectSpendCoins({ candidates: [a, dup], target: 10n, asset: XCH, coinOf, select });
    expect(out.selected).toHaveLength(2);
  });

  it('throws NeedsConsolidationError when enough value needs more than the cap', () => {
    const select = (): SelectCoinsResult => ({
      ok: false,
      needsConsolidation: true,
      asset: XCH,
      availableCoinCount: 120,
      availableTotal: 500n,
      required: 100n,
      cap: COIN_CAP,
    });
    let thrown: unknown;
    try {
      selectSpendCoins({ candidates: [mk('x', 1n)], target: 100n, asset: XCH, coinOf, select });
    } catch (e) {
      thrown = e;
    }
    expect(isNeedsConsolidationError(thrown)).toBe(true);
    expect(isInsufficientFundsError(thrown)).toBe(false);
    expect((thrown as Error).message).toMatch(/^NEEDS_CONSOLIDATION:/); // vault extracts this code
    expect((thrown as NeedsConsolidationError).info.availableCoinCount).toBe(120);
  });

  it('throws InsufficientFundsError when the total is genuinely short', () => {
    const select = (): SelectCoinsResult => ({
      ok: false,
      needsConsolidation: false,
      asset: XCH,
      availableCoinCount: 2,
      availableTotal: 30n,
      required: 100n,
      cap: COIN_CAP,
    });
    let thrown: unknown;
    try {
      selectSpendCoins({ candidates: [mk('x', 30n)], target: 100n, asset: XCH, coinOf, select });
    } catch (e) {
      thrown = e;
    }
    expect(isInsufficientFundsError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(/^INSUFFICIENT_FUNDS:/);
    expect((thrown as InsufficientFundsError).info.required).toBe(100n);
  });

  it('passes a custom cap through to the selector', () => {
    const select = vi.fn((): SelectCoinsResult => ({ ok: true, coins: [], total: 0n, change: 0n, coinCount: 0, asset: XCH }));
    selectSpendCoins({ candidates: [], target: 0n, asset: XCH, coinOf, select, cap: 7 });
    expect(select).toHaveBeenCalledWith([], 0n, XCH, 7);
  });
});
