import type { ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { StatusPill } from '@/components/StatusPill';
import {
  useGetPairingStateQuery,
  useStartPairingMutation,
  useCancelPairingMutation,
  useUnpairMutation,
} from '@/features/control/pairingApi';
import { pairingViewModel, initialPairingState } from '@/lib/dig-pairing';

/**
 * The control-token PAIRING gate (#280/#281). The token-gated management sections
 * (upstream/hosted-stores/sync/peers) render as `children` ONLY when paired; otherwise this shows
 * the pairing affordance — request a code, show it + the `dig-node pair approve <id>` instruction
 * for the operator to confirm, poll to `paired`, and an Unpair control once paired.
 */
export function PairingSection({ children }: { children: ReactNode }) {
  const { data } = useGetPairingStateQuery();
  const [startPairing, startState] = useStartPairingMutation();
  const [cancelPairing] = useCancelPairingMutation();
  const [unpair] = useUnpairMutation();

  const state = data ?? initialPairingState();
  const vm = pairingViewModel(state);

  return (
    <section className="dig-card" data-testid="control-pairing" data-phase={vm.phase} aria-labelledby="control-pairing-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 className="dig-heading" id="control-pairing-title" style={{ margin: 0 }}>
          <FormattedMessage id="control.pairing.title" />
        </h3>
        <StatusPill tone={vm.tone} testid="control-pairing-pill">
          <FormattedMessage id={vm.titleId} />
        </StatusPill>
      </div>

      <p className="dig-muted" data-testid="control-pairing-body">
        <FormattedMessage id={vm.bodyId} />
      </p>

      {/* Awaiting approval: show the compare-codes value + the operator instruction. */}
      {vm.phase === 'awaiting' && vm.code && (
        <div data-testid="control-pairing-code" aria-live="polite" style={{ margin: '8px 0' }}>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, fontFamily: 'monospace' }}>{vm.code}</div>
          <p className="dig-muted" style={{ fontSize: 12 }}>
            <FormattedMessage id="control.pairing.awaiting.cmd" values={{ id: vm.pairingId ?? '' }} />
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {vm.showPairButton && (
          <button
            type="button"
            className="dig-btn dig-btn--primary"
            data-testid="control-pairing-start"
            onClick={() => void startPairing()}
            disabled={startState.isLoading}
          >
            <FormattedMessage id="control.pairing.start" />
          </button>
        )}
        {vm.showCancelButton && (
          <button type="button" className="dig-btn" data-testid="control-pairing-cancel" onClick={() => void cancelPairing()}>
            <FormattedMessage id="control.pairing.cancel" />
          </button>
        )}
        {vm.showUnpairButton && (
          <button type="button" className="dig-btn" data-testid="control-pairing-unpair" onClick={() => void unpair()}>
            <FormattedMessage id="control.pairing.unpair" />
          </button>
        )}
      </div>

      {/* The token-gated management surfaces render only once paired. */}
      {vm.phase === 'paired' && <div data-testid="control-pairing-managed">{children}</div>}
    </section>
  );
}
