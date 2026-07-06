/**
 * Chia-native spend-risk heuristics (#67 P0-3 — drainer / malicious-spend detection).
 *
 * A dApp builds a spend and asks the custody wallet to sign it. Before the user approves, we inspect
 * the tamper-resistant summary decoded FROM THE BUILT SPEND (`decodeDappSpend`, §18.12) and flag
 * high-risk patterns — the anti-drainer UX: a user should be warned when a "sign this" request would
 * move nearly all of their selected funds to an address outside their wallet, carries an anomalously
 * large network fee, cannot be fully signed by this wallet, or mixes in coins the wallet does not own
 * (whose amounts cannot be trusted). All heuristics are ORIGINAL and reason purely on the Chia
 * coin/CLVM facts already in the summary — no Ethereum lists, no hosted scoring, nothing sent off the
 * device. A hosted simulation/scoring tier is a later optional add-on (backlog P2-4); this ships the
 * local, private first line of defense.
 *
 * Pure (no chrome, no wasm): the summary it reads is already tamper-resistant, so risk can be
 * computed anywhere (it is computed in the approval window from the queued summary).
 */

import type { DappSpendSummary } from '@/offscreen/dappSign';

/** Stable machine codes for each risk finding (agent-consumable; also drive the i18n message ids). */
export const RISK = Object.freeze({
  /** Nearly all of the value leaving the selected coins goes to an address outside the wallet. */
  DRAIN_ALL: 'DRAIN_ALL',
  /** The reserved network fee is anomalously large (exceeds the amount sent, or a large absolute). */
  HIGH_FEE: 'HIGH_FEE',
  /** The spend requires a signature the wallet cannot provide (it will not fully sign). */
  CANNOT_SIGN: 'CANNOT_SIGN',
  /** The spend mixes in coins the wallet does not own — the mojo amounts cannot be verified. */
  FOREIGN_INPUTS: 'FOREIGN_INPUTS',
} as const);

/** One risk finding: a stable code + its severity. */
export interface RiskFinding {
  code: (typeof RISK)[keyof typeof RISK];
  severity: 'caution' | 'high';
}

/** The overall risk assessment for a decoded spend. */
export interface SpendRisk {
  /** `none` (no findings) · `caution` (only cautions) · `high` (≥1 high-severity finding). */
  level: 'none' | 'caution' | 'high';
  findings: RiskFinding[];
  /** True iff the UI must require an explicit extra confirm before Approve (any high finding). */
  requiresExtraConfirm: boolean;
}

/**
 * Drain trigger: change kept back is ≤ this fraction of the value leaving the wallet. A drainer
 * empties the selected coins to a stranger with (near-)zero change; a genuine payment keeps
 * meaningful change. 1% tolerates rounding / true "send it all" without flagging ordinary payments.
 */
const DRAIN_CHANGE_FRACTION_BP = 100n; // basis points (100 / 10_000 = 1%)
const BP_DENOM = 10_000n;

/** Absolute fee above which a spend is flagged regardless of amount: 0.1 XCH (100e9 mojos). */
const HIGH_FEE_ABS_MOJOS = 100_000_000_000n;

/** Parse a decimal mojo string to bigint; non-numeric / negative collapses to 0n. */
function mojos(s: string | undefined): bigint {
  if (!s) return 0n;
  try {
    const n = BigInt(s);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Assess the risk of a decoded dApp spend. Mojo-based heuristics (drain, fee) are computed only when
 * every input coin is the wallet's own (`allInputsSelf`) — the summary's amounts are trustworthy only
 * then (§18.12); otherwise a foreign-inputs caution is raised instead. Signer-coverage is always
 * checkable. A `null`/`undefined` summary (message request, not-yet-decoded) has no spend risk.
 */
export function assessSpendRisk(summary: DappSpendSummary | null | undefined): SpendRisk {
  const findings: RiskFinding[] = [];
  if (summary) {
    if (summary.allInputsSelf) {
      const sending = mojos(summary.sendingMojos);
      const change = mojos(summary.changeMojos);
      const fee = mojos(summary.feeMojos);

      // DRAIN_ALL: value leaves the wallet and (near-)nothing is kept back as change.
      if (sending > 0n && change * BP_DENOM <= sending * DRAIN_CHANGE_FRACTION_BP) {
        findings.push({ code: RISK.DRAIN_ALL, severity: 'high' });
      }

      // HIGH_FEE: fee exceeds the amount actually sent, or a large absolute fee.
      if (fee > 0n && (fee >= HIGH_FEE_ABS_MOJOS || (sending > 0n && fee > sending))) {
        findings.push({ code: RISK.HIGH_FEE, severity: 'high' });
      }
    } else {
      findings.push({ code: RISK.FOREIGN_INPUTS, severity: 'caution' });
    }

    // CANNOT_SIGN: a required signer the wallet cannot satisfy (checkable regardless of input trust).
    if (summary.requiredSigners.length > 0 && summary.ownedSigners < summary.requiredSigners.length) {
      findings.push({ code: RISK.CANNOT_SIGN, severity: 'caution' });
    }
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const level: SpendRisk['level'] = findings.length === 0 ? 'none' : hasHigh ? 'high' : 'caution';
  return { level, findings, requiresExtraConfirm: hasHigh };
}
