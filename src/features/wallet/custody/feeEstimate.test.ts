import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SEND_COST,
  FEE_TARGET_TIMES,
  FALLBACK_FEE_MOJOS,
  buildFeeEstimateRequest,
  parseFeePresets,
  fetchFeeEstimate,
  feeEstimateUrl,
  type FeePresets,
} from '@/features/wallet/custody/feeEstimate';

describe('feeEstimate — request building', () => {
  it('sends the nominal send cost and the three preset target times (fast→slow)', () => {
    const req = buildFeeEstimateRequest();
    expect(req.cost).toBe(DEFAULT_SEND_COST);
    // Order is fast, normal, slow so response.estimates[i] aligns to the preset by index.
    expect(req.target_times).toEqual([FEE_TARGET_TIMES.fast, FEE_TARGET_TIMES.normal, FEE_TARGET_TIMES.slow]);
    // fast targets the soonest inclusion (smallest wait), slow the longest.
    expect(FEE_TARGET_TIMES.fast).toBeLessThan(FEE_TARGET_TIMES.normal);
    expect(FEE_TARGET_TIMES.normal).toBeLessThan(FEE_TARGET_TIMES.slow);
  });

  it('honors an explicit cost override', () => {
    expect(buildFeeEstimateRequest(42).cost).toBe(42);
  });

  it('builds the coinset get_fee_estimate URL from a base', () => {
    expect(feeEstimateUrl('https://api.coinset.org')).toBe('https://api.coinset.org/get_fee_estimate');
    // Tolerates a trailing slash on the base.
    expect(feeEstimateUrl('https://my.node/')).toBe('https://my.node/get_fee_estimate');
  });
});

describe('feeEstimate — response parsing', () => {
  it('maps estimates[0..2] to fast/normal/slow', () => {
    const presets = parseFeePresets({ estimates: [500, 200, 50], target_times: [60, 120, 300], success: true });
    expect(presets).toEqual<FeePresets>({ fast: 500, normal: 200, slow: 50 });
  });

  it('coerces to non-negative integers and drops fractional/garbage estimates to 0', () => {
    const presets = parseFeePresets({ estimates: [-5, 12.9, 'nope'] });
    expect(presets.fast).toBe(0); // negative → 0
    expect(presets.normal).toBe(12); // floored
    expect(presets.slow).toBe(0); // non-numeric → 0
  });

  it('falls back to all-zero presets when estimates is missing or not an array', () => {
    expect(parseFeePresets({})).toEqual({ fast: 0, normal: 0, slow: 0 });
    expect(parseFeePresets(null)).toEqual({ fast: 0, normal: 0, slow: 0 });
    expect(parseFeePresets({ estimates: 'x' })).toEqual({ fast: 0, normal: 0, slow: 0 });
  });

  it('pads a short estimates array with 0 (an empty mempool legitimately yields 0 fee)', () => {
    expect(parseFeePresets({ estimates: [0] })).toEqual({ fast: 0, normal: 0, slow: 0 });
  });
});

describe('feeEstimate — fetch', () => {
  it('POSTs to <base>/get_fee_estimate and returns parsed presets', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ estimates: [700, 300, 100], target_times: [60, 120, 300], success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = await fetchFeeEstimate(fetchImpl, 'https://api.coinset.org');
    expect(res.presets).toEqual({ fast: 700, normal: 300, slow: 100 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.coinset.org/get_fee_estimate');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.cost).toBe(DEFAULT_SEND_COST);
    expect(body.target_times).toEqual([60, 120, 300]);
  });

  it('throws on a non-2xx response so the caller can fall back honestly', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 }));
    await expect(fetchFeeEstimate(fetchImpl, 'https://api.coinset.org')).rejects.toThrow();
  });

  it('exposes a sane, non-negative fallback fee constant', () => {
    expect(FALLBACK_FEE_MOJOS).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(FALLBACK_FEE_MOJOS)).toBe(true);
  });
});
