/**
 * dig-dns Path-B indicator view-model — PURE (no DOM/chrome.*) mapping from a `getDigDnsStatus`
 * snapshot (src/lib/dig-dns.ts) to the tone + message id the Resolver tab's small ".dig local
 * resolution" indicator renders. Kept separate from the state machine itself so the presentation
 * mapping is independently testable, mirroring `resolve-status.ts`'s split for the node ladder.
 */
import type { PillTone } from '@/components/StatusPill';
import type { DigDnsPhase, DigDnsSnapshot } from '@/lib/dig-dns';

/** The tone + react-intl message id the indicator renders for one {@link DigDnsPhase}. */
export interface DigDnsIndicatorView {
  tone: PillTone;
  labelId: string;
}

const VIEW_BY_PHASE: Record<DigDnsPhase, DigDnsIndicatorView> = {
  unknown: { tone: 'neutral', labelId: 'resolver.digdns.status.unknown' },
  direct: { tone: 'good', labelId: 'resolver.digdns.status.direct' },
  proxy: { tone: 'warn', labelId: 'resolver.digdns.status.proxy' },
  unavailable: { tone: 'neutral', labelId: 'resolver.digdns.status.unavailable' },
};

/** The subset of a `getDigDnsStatus` response this view-model reads. */
export type DigDnsStatusInput = Pick<DigDnsSnapshot, 'phase'> | null | undefined;

/** Map a dig-dns availability snapshot to the indicator's tone + message id. Defaults to `unknown`. */
export function digDnsIndicatorView(snapshot: DigDnsStatusInput): DigDnsIndicatorView {
  const phase = snapshot?.phase;
  return VIEW_BY_PHASE[phase as DigDnsPhase] ?? VIEW_BY_PHASE.unknown;
}
