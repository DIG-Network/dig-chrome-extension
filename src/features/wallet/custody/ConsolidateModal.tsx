import { FormattedMessage, useIntl } from 'react-intl';
import { Sheet } from '@/components/Sheet';
import { formatBaseUnits } from '@/lib/wallet-view';
import type { ConsolidationPhase, ConsolidateQuote } from './consolidateLoop';

const XCH_DECIMALS = 12;

/** The modal's driving state (owned by {@link useConsolidatingSend}). `idle`/`!open` renders nothing. */
export interface ConsolidateModalState {
  open: boolean;
  phase: ConsolidationPhase;
  quote: ConsolidateQuote | null;
}

/**
 * The honest, dismissible auto-consolidate modal (#417) — the ONE screen-overtaking prompt the
 * send/spend loop shows when a coin-fragmented wallet can't fund a spend within the coin-count cap.
 *
 * - `prompting` → an HONEST consent ask (NO dark pattern, §6.0/#207): it states plainly that the
 *   wallet holds many small coins, how many this round combines, the XCH fee, and offers a clear
 *   "Combine coins" primary + a "Not now" secondary. Escape / backdrop cancel it — combining is never
 *   forced.
 * - `consolidating` / `confirming` / `retrying` → a live-region progress state while the combine
 *   broadcasts + confirms on chain (an in-flight on-chain action is not cancellable, so the dismiss
 *   affordances are inert here — honest, not a trap).
 *
 * Built on the shared {@link Sheet} primitive (portal + focus-trap + `role="dialog"` + Escape/backdrop
 * per WCAG 2.2). All copy is react-intl. Presentational: the loop's decisions are injected as
 * `onConfirm` / `onCancel`.
 */
export function ConsolidateModal({
  state,
  onConfirm,
  onCancel,
}: {
  state: ConsolidateModalState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  if (!state.open || state.phase === 'idle') return null;

  const title = intl.formatMessage({ id: 'consolidate.title' });
  const isPrompt = state.phase === 'prompting';
  // Only the consent prompt is dismissible; an in-flight on-chain combine is not cancellable.
  const onClose = isPrompt ? onCancel : () => {};

  return (
    <Sheet title={title} onClose={onClose} testid="consolidate-modal">
      {isPrompt && state.quote ? (
        <div data-testid="consolidate-prompt">
          <p style={{ marginTop: 0 }}>
            <FormattedMessage id="consolidate.body" values={{ count: state.quote.coinsMerged }} />
          </p>
          <p className="dig-muted" data-testid="consolidate-fee">
            <FormattedMessage
              id="consolidate.fee"
              values={{ fee: `${formatBaseUnits(Number(state.quote.fee), XCH_DECIMALS)} XCH` }}
            />
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="dig-btn dig-btn--primary" style={{ flex: 1 }} data-testid="consolidate-confirm" onClick={onConfirm}>
              <FormattedMessage id="consolidate.combine" />
            </button>
            <button type="button" className="dig-btn" style={{ flex: 1 }} data-testid="consolidate-cancel" onClick={onCancel}>
              <FormattedMessage id="consolidate.cancel" />
            </button>
          </div>
        </div>
      ) : (
        <div className="dig-state" data-state="loading" role="status" aria-live="polite" data-testid="consolidate-progress">
          <p style={{ marginTop: 0 }}>
            <FormattedMessage id={`consolidate.progress.${state.phase}`} />
          </p>
          <p className="dig-muted" style={{ marginBottom: 0 }}>
            <FormattedMessage id="consolidate.progress.note" />
          </p>
        </div>
      )}
    </Sheet>
  );
}
