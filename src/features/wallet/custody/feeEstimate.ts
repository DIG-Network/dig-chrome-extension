/**
 * Network-fee estimation (#206/#110) — the PURE data logic behind the Send flow's fee line item.
 *
 * The default fee comes from coinset.org's full-node fee endpoint (`POST /get_fee_estimate`), which
 * returns, for a spend of a given CLVM `cost`, the estimated total fee (in mojos) to be included
 * within each requested `target_time` (seconds from now). We request THREE target times in one call
 * — fast / normal / slow — and expose them as user-facing presets (#110). The Send UI defaults to
 * the "normal" estimate and lets the user pick a preset or override the value entirely (#206).
 *
 * No DOM / `chrome.*` / RTK here — the network step is isolated in `fetchFeeEstimate(fetchImpl, …)`
 * so every branch is unit-testable with a fake fetch (mirrors the `priceSources.ts` idiom). The RTK
 * Query wiring lives in `feeApi.ts`; the UI in `FeeField.tsx`.
 *
 * NOTE (#205 direction): when a dig-node Sage-parity RPC becomes the wallet-data source, the fee
 * estimate should come from that node's fee endpoint where available; coinset.org is the default /
 * fallback. The source is resolved behind `resolveCoinsetUrl` (the same §5.3 node-first override the
 * balance scan uses), so a custom-node override already flows through — a node lacking the endpoint
 * simply surfaces as a fetch error and the UI falls back to {@link FALLBACK_FEE_MOJOS} + override.
 */

/** The three preset speeds, fastest (soonest inclusion, highest fee) to slowest. */
export type FeeSpeed = 'fast' | 'normal' | 'slow';

/** Estimated total fee in MOJOS for each preset speed. */
export interface FeePresets {
  fast: number;
  normal: number;
  slow: number;
}

/** The resolved estimate: the three presets plus the target times they were computed for. */
export interface FeeEstimateResult {
  presets: FeePresets;
  targetTimes: { fast: number; normal: number; slow: number };
}

/**
 * Target inclusion times (seconds from now) for each preset. Chia blocks land ~every 52 s, so `fast`
 * targets roughly the next block, `normal` a few blocks, `slow` several — the classic fast/normal/
 * slow tradeoff. Ordered fast→slow so `estimates[i]` from the response aligns to the preset by index.
 */
export const FEE_TARGET_TIMES = { fast: 60, normal: 120, slow: 300 } as const;

/**
 * A nominal CLVM cost for a simple XCH send, used to price the fee BEFORE the spend is built (the fee
 * is chosen on the form, ahead of `prepareSend`). A single-input, few-output XCH spend costs well
 * under this; a modest overestimate biases the resulting fee slightly high (toward inclusion) rather
 * than too low. Callers with a real built spend's cost may pass it explicitly.
 */
export const DEFAULT_SEND_COST = 1_000_000_000;

/**
 * The honest fallback fee (mojos) when the estimate is unavailable (endpoint down / custom node
 * without the endpoint). 0 is a valid, commonly-accepted Chia fee when the mempool is uncongested;
 * the UI shows an honest "estimate unavailable" note and always allows an override, so this never
 * silently overpays.
 */
export const FALLBACK_FEE_MOJOS = 0;

/** The coinset (full-node) fee-estimate request body. */
export interface FeeEstimateRequest {
  cost: number;
  target_times: number[];
}

/** Build the `get_fee_estimate` request body for the given spend cost (default nominal send cost). */
export function buildFeeEstimateRequest(cost: number = DEFAULT_SEND_COST): FeeEstimateRequest {
  return { cost, target_times: [FEE_TARGET_TIMES.fast, FEE_TARGET_TIMES.normal, FEE_TARGET_TIMES.slow] };
}

/** The full-node `get_fee_estimate` endpoint URL for a coinset-compatible base (trailing slash safe). */
export function feeEstimateUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/get_fee_estimate`;
}

/** Coerce one estimate to a non-negative integer mojo count (garbage / negative / fractional → floor≥0). */
function coerceMojos(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse a `get_fee_estimate` response into fast/normal/slow presets. `estimates[0..2]` align to the
 * target times we requested (fast, normal, slow). Tolerant: a missing/short/garbage array yields 0s
 * (an empty mempool legitimately estimates a 0 fee), never a throw.
 */
export function parseFeePresets(json: unknown): FeePresets {
  const estimates = (json as { estimates?: unknown } | null)?.estimates;
  const arr = Array.isArray(estimates) ? estimates : [];
  return { fast: coerceMojos(arr[0]), normal: coerceMojos(arr[1]), slow: coerceMojos(arr[2]) };
}

/**
 * Fetch + parse a fee estimate from a coinset-compatible base URL. Throws on a non-2xx response so
 * the caller (RTK Query `queryFn`) surfaces an `error` and the UI falls back to {@link
 * FALLBACK_FEE_MOJOS} + manual override.
 */
export async function fetchFeeEstimate(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string,
  cost: number = DEFAULT_SEND_COST,
): Promise<FeeEstimateResult> {
  const res = await fetchImpl(feeEstimateUrl(baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildFeeEstimateRequest(cost)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return {
    presets: parseFeePresets(json),
    targetTimes: { fast: FEE_TARGET_TIMES.fast, normal: FEE_TARGET_TIMES.normal, slow: FEE_TARGET_TIMES.slow },
  };
}
