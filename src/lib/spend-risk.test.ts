/**
 * Tests for the Chia-native spend-risk heuristics (#67 P0-3 — drainer / malicious-spend detection).
 *
 * `assessSpendRisk` inspects the tamper-resistant summary decoded FROM THE BUILT SPEND
 * (`decodeDappSpend`) and flags high-risk patterns BEFORE the user signs — a drainer that moves
 * nearly all selected value to an external address, an anomalously large network fee, a spend the
 * wallet cannot fully sign, or a spend mixing in coins the wallet does not own (whose amounts cannot
 * be trusted). Pure (no chrome / no wasm) — the facts are already tamper-resistant.
 */
import { describe, it, expect } from 'vitest';
import { assessSpendRisk, RISK } from '@/lib/spend-risk';
import type { DappSpendSummary } from '@/offscreen/dappSign';

const XCH = 1_000_000_000_000n; // 1 XCH in mojos

/** Build a summary with sensible defaults; override only what a case exercises. */
function summary(over: Partial<DappSpendSummary> = {}): DappSpendSummary {
  return {
    coinCount: 1,
    inputs: [{ coinId: 'aa', puzzleHash: 'self1', amount: (10n * XCH).toString(), isSelf: true }],
    outputs: [],
    feeMojos: '0',
    sendingMojos: '0',
    changeMojos: '0',
    allInputsSelf: true,
    requiredSigners: ['pk1'],
    ownedSigners: 1,
    ...over,
  };
}

describe('assessSpendRisk', () => {
  it('a normal send (mostly change back, small external) is not high-risk', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: (1n * XCH).toString(),
        changeMojos: (9n * XCH).toString(),
        outputs: [
          { puzzleHash: 'ext1', amount: (1n * XCH).toString(), isSelf: false },
          { puzzleHash: 'self1', amount: (9n * XCH).toString(), isSelf: true },
        ],
      }),
    );
    expect(r.level).toBe('none');
    expect(r.requiresExtraConfirm).toBe(false);
    expect(r.findings).toHaveLength(0);
  });

  it('flags a drain: nearly all value leaves to an external address, no change back', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: (10n * XCH).toString(),
        changeMojos: '0',
        outputs: [{ puzzleHash: 'ext1', amount: (10n * XCH).toString(), isSelf: false }],
      }),
    );
    expect(r.level).toBe('high');
    expect(r.requiresExtraConfirm).toBe(true);
    expect(r.findings.map((f) => f.code)).toContain(RISK.DRAIN_ALL);
  });

  it('flags a drain when change is a negligible fraction of what leaves', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: (10n * XCH).toString(),
        changeMojos: '500', // < 1% of the value leaving
        outputs: [{ puzzleHash: 'ext1', amount: (10n * XCH).toString(), isSelf: false }],
      }),
    );
    expect(r.findings.map((f) => f.code)).toContain(RISK.DRAIN_ALL);
  });

  it('does NOT flag a drain when nothing leaves the wallet (self-transfer / consolidation)', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: '0',
        changeMojos: (10n * XCH).toString(),
        outputs: [{ puzzleHash: 'self1', amount: (10n * XCH).toString(), isSelf: true }],
      }),
    );
    expect(r.findings.map((f) => f.code)).not.toContain(RISK.DRAIN_ALL);
  });

  it('flags an anomalously large fee (fee exceeds the amount actually sent)', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: (1n * XCH).toString(),
        changeMojos: (1n * XCH).toString(),
        feeMojos: (2n * XCH).toString(),
        outputs: [
          { puzzleHash: 'ext1', amount: (1n * XCH).toString(), isSelf: false },
          { puzzleHash: 'self1', amount: (1n * XCH).toString(), isSelf: true },
        ],
      }),
    );
    expect(r.level).toBe('high');
    expect(r.findings.map((f) => f.code)).toContain(RISK.HIGH_FEE);
  });

  it('flags a large absolute fee even when a lot is sent', () => {
    const r = assessSpendRisk(
      summary({
        sendingMojos: (100n * XCH).toString(),
        changeMojos: (100n * XCH).toString(),
        feeMojos: (1n * XCH).toString(), // 1 XCH fee — well above the absolute threshold
        outputs: [
          { puzzleHash: 'ext1', amount: (100n * XCH).toString(), isSelf: false },
          { puzzleHash: 'self1', amount: (100n * XCH).toString(), isSelf: true },
        ],
      }),
    );
    expect(r.findings.map((f) => f.code)).toContain(RISK.HIGH_FEE);
  });

  it('does not compute mojo-based drain/fee flags when inputs are not all self (untrusted amounts)', () => {
    const r = assessSpendRisk(
      summary({
        allInputsSelf: false,
        sendingMojos: (10n * XCH).toString(),
        changeMojos: '0',
        feeMojos: (5n * XCH).toString(),
      }),
    );
    // No DRAIN_ALL / HIGH_FEE (amounts can't be trusted), but the foreign-input caution IS raised.
    expect(r.findings.map((f) => f.code)).not.toContain(RISK.DRAIN_ALL);
    expect(r.findings.map((f) => f.code)).not.toContain(RISK.HIGH_FEE);
    expect(r.findings.map((f) => f.code)).toContain(RISK.FOREIGN_INPUTS);
  });

  it('flags an over-broad/foreign-signer spend as HIGH and requires explicit confirmation (#75)', () => {
    // A required signer the wallet cannot account for → the self-custody signer is all-or-nothing,
    // so this is either a failed request or an over-broad authorization: HIGH, must be acknowledged.
    const r = assessSpendRisk(summary({ requiredSigners: ['pk1', 'pk2'], ownedSigners: 1 }));
    expect(r.findings.map((f) => f.code)).toContain(RISK.CANNOT_SIGN);
    expect(r.findings.find((f) => f.code === RISK.CANNOT_SIGN)?.severity).toBe('high');
    expect(r.level).toBe('high');
    expect(r.requiresExtraConfirm).toBe(true);
  });

  it('drives the foreign-signer flag off the enumerated unaccountedSigners list when present (#75)', () => {
    const r = assessSpendRisk(summary({ requiredSigners: ['pk1', 'pk2'], ownedSigners: 2, unaccountedSigners: ['pk2'] }));
    expect(r.findings.map((f) => f.code)).toContain(RISK.CANNOT_SIGN);
    expect(r.level).toBe('high');
  });

  it('does NOT flag a fully-accountable spend (no unaccounted signers)', () => {
    const r = assessSpendRisk(summary({ requiredSigners: ['pk1'], ownedSigners: 1, unaccountedSigners: [] }));
    expect(r.findings.map((f) => f.code)).not.toContain(RISK.CANNOT_SIGN);
  });

  it('escalates to high when any high-severity finding is present alongside cautions', () => {
    const r = assessSpendRisk(
      summary({
        requiredSigners: ['pk1', 'pk2'],
        ownedSigners: 1,
        sendingMojos: (10n * XCH).toString(),
        changeMojos: '0',
        outputs: [{ puzzleHash: 'ext1', amount: (10n * XCH).toString(), isSelf: false }],
      }),
    );
    expect(r.level).toBe('high');
    expect(r.requiresExtraConfirm).toBe(true);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain(RISK.DRAIN_ALL);
    expect(codes).toContain(RISK.CANNOT_SIGN);
  });

  it('tolerates a null / missing summary (returns none)', () => {
    expect(assessSpendRisk(null).level).toBe('none');
    expect(assessSpendRisk(undefined).findings).toHaveLength(0);
  });
});
