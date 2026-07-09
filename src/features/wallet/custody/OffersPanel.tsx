import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { legLabel } from '@/features/wallet/custody/offerLegFormat';
import { useGetCustodyOffersQuery, usePrepareTradeMutation, useConfirmTradeMutation } from '@/features/wallet/custodyApi';
import type { OfferLogEntry } from '@/lib/offer-log';

/** The message id for one offer's status badge — `expired` (reserved, never currently emitted —
 * see `offer-log.ts`'s module doc) falls back to the `cancelled` copy defensively. */
function statusMessageId(status: OfferLogEntry['status']): string {
  if (status === 'open') return 'trade.offers.status.open';
  if (status === 'taken') return 'trade.offers.status.taken';
  return 'trade.offers.status.cancelled';
}

/**
 * "Your offers" (#101) — the LOCAL log of offers this wallet has MADE (`makeOffer`), with derived
 * status (open/taken/cancelled — see `lib/offer-log.ts`'s module doc for how status is inferred).
 * An instant storage read reconciled against the chain for open entries, NOT a marketplace scan.
 *
 * **Surface tiering, extending §18.10's advanced-capability gating (#100's NFT/multi-asset
 * pattern).** Both surfaces show the SAME list + status; only fullscreen (`full`) renders the
 * per-offer ACTIONS (re-share via copy, and cancel for a still-open offer) — the popup is
 * VIEW-ONLY, matching the task's "offer management is fullscreen-featured; popup stays view-only +
 * open full screen" tiering (the persistent `trade-open-fullscreen` link in {@link TradePanel}'s
 * mode-tab row already covers "go manage it").
 */
export function OffersPanel({ full }: { full: boolean }) {
  const offers = useGetCustodyOffersQuery();
  const [prepareTrade, pt] = usePrepareTradeMutation();
  const [confirmTrade, ct] = useConfirmTradeMutation();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [cancelledIds, setCancelledIds] = useState<ReadonlySet<string>>(new Set());
  const [failedId, setFailedId] = useState<string | null>(null);

  function copyOffer(id: string, offer: string) {
    void navigator.clipboard?.writeText(offer).then(
      () => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      },
      () => {
        /* clipboard denied — no toast; the offer string is still visible via the deal card */
      },
    );
  }

  async function doCancel(entry: OfferLogEntry) {
    setFailedId(null);
    const prep = await prepareTrade({ offerStr: entry.offer, tradeKind: 'cancel' });
    if (!('data' in prep) || !prep.data?.pendingId) {
      setFailedId(entry.id);
      return;
    }
    const done = await confirmTrade({ pendingId: prep.data.pendingId });
    if ('data' in done && done.data?.spentCoinId) setCancelledIds((s) => new Set(s).add(entry.id));
    else setFailedId(entry.id);
  }

  const rows = offers.data?.offers ?? [];
  const busy = pt.isLoading || ct.isLoading;

  return (
    <div data-testid="offers-panel">
      <FourState
        isLoading={offers.isLoading}
        isError={offers.isError}
        isEmpty={!offers.isLoading && !offers.isError && rows.length === 0}
        onRetry={() => void offers.refetch()}
        testid="offers"
        emptyId="trade.offers.empty"
      >
        <ul className="dig-list" data-testid="offers-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((o) => (
            <li key={o.id} className="dig-card" data-testid={`offer-row-${o.id}`} style={{ marginBottom: 8 }}>
              <dl className="dig-summary">
                <dt><FormattedMessage id="trade.summary.youGet" /></dt>
                <dd>{o.summary.offered.map((l) => legLabel(l)).join(', ') || '—'}</dd>
                <dt><FormattedMessage id="trade.summary.youPay" /></dt>
                <dd>{o.summary.requested.map((l) => legLabel(l)).join(', ') || '—'}</dd>
              </dl>
              <span data-testid={`offer-status-${o.id}`} data-status={o.status} className="dig-muted">
                <FormattedMessage id={statusMessageId(o.status)} />
              </span>
              {full && (
                <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                  <button type="button" className="dig-btn" data-testid={`offer-copy-${o.id}`} onClick={() => copyOffer(o.id, o.offer)}>
                    <FormattedMessage id={copiedId === o.id ? 'trade.deal.copied' : 'trade.deal.copy'} />
                  </button>
                  {o.status === 'open' && !cancelledIds.has(o.id) && (
                    <button
                      type="button"
                      className="dig-link"
                      data-testid={`offer-cancel-${o.id}`}
                      onClick={() => void doCancel(o)}
                      disabled={busy}
                    >
                      <FormattedMessage id={busy ? 'custody.working' : 'trade.cancel.action'} />
                    </button>
                  )}
                  {cancelledIds.has(o.id) && (
                    <span className="dig-state" data-state="success" role="status" data-testid={`offer-cancelled-${o.id}`}>
                      <FormattedMessage id="trade.cancel.done" />
                    </span>
                  )}
                  {failedId === o.id && (
                    <span className="dig-error-text" role="alert" data-testid={`offer-cancel-failed-${o.id}`}>
                      <FormattedMessage id="trade.cancel.failed" />
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </FourState>
    </div>
  );
}
