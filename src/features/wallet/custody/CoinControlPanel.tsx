import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import {
  useGetCoinsQuery,
  usePrepareSplitMutation,
  usePrepareCombineMutation,
  useConfirmSendMutation,
  useLazySendStatusQuery,
  type PreparedCoinOp,
} from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;

type Phase = 'list' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Coin control (#91) — the individual-coin surface. Lists the selected asset's unspent coins
 * (amount, short id, confirmed height), lets the user multi-select, then COMBINE (≥2 → one coin) or
 * SPLIT (exactly one → N coins). Plain-language (§6.1): combine "small coins", split into "exact
 * amounts". A state machine mirroring Send: list → review (decoded, self-send-verified summary) →
 * confirm (sign + BROADCAST via the shared confirmSend) → poll → done. `pollMs` is injectable for tests.
 */
export function CoinControlPanel({ assets, onClose, pollMs = 8000 }: { assets: AssetBalance[]; onClose?: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('list');
  const [assetIdx, setAssetIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outputs, setOutputs] = useState(2);
  const [fee, setFee] = useState('0');
  const [prepared, setPrepared] = useState<PreparedCoinOp | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedAsset = assets[assetIdx] ?? assets[0];
  const decimals = selectedAsset?.descriptor.decimals ?? XCH_DECIMALS;
  const ticker = selectedAsset?.descriptor.ticker ?? 'XCH';
  const assetId = selectedAsset?.descriptor.assetId ?? undefined; // undefined → native XCH

  const coinsQuery = useGetCoinsQuery({ ...(assetId ? { assetId } : {}) });
  const [prepareSplit, splitState] = usePrepareSplitMutation();
  const [prepareCombine, combineState] = usePrepareCombineMutation();
  const [confirmSend, confirmState] = useConfirmSendMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const coins = useMemo(() => coinsQuery.data?.coins ?? [], [coinsQuery.data]);
  // Drop any selection no longer present in the current asset's coin set (asset switch / refresh).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(coins.map((c) => c.coinId));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [coins]);

  const busy = splitState.isLoading || combineState.isLoading || confirmState.isLoading;
  const feeMojos = safeMojos(fee);

  function toggle(coinId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(coinId)) next.delete(coinId);
      else next.add(coinId);
      return next;
    });
  }

  function switchAsset(idx: number) {
    setAssetIdx(idx);
    setSelected(new Set());
  }

  async function doCombine() {
    setLocalError(null);
    const res = await prepareCombine({ coinIds: [...selected], fee: String(feeMojos), ...(assetId ? { assetId } : {}) });
    if ('data' in res && res.data?.pendingId) {
      setPrepared(res.data);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'coins.error.build' }));
    }
  }

  async function doSplit() {
    setLocalError(null);
    const res = await prepareSplit({ coinIds: [...selected], outputs, fee: String(feeMojos), ...(assetId ? { assetId } : {}) });
    if ('data' in res && res.data?.pendingId) {
      setPrepared(res.data);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'coins.error.build' }));
    }
  }

  async function doConfirm() {
    if (!prepared) return;
    setPhase('sending');
    const res = await confirmSend({ pendingId: prepared.pendingId });
    if ('data' in res && res.data?.spentCoinId) setSpentCoinId(res.data.spentCoinId);
    else setPhase('failed');
  }

  useEffect(() => {
    if (phase !== 'sending' || !spentCoinId) return;
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        setPhase('confirmed');
        clearInterval(timer);
      }
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase, spentCoinId, pollMs, pollStatus]);

  return (
    <section className="dig-card" data-testid="coin-control" aria-labelledby="coins-title">
      <h2 className="dig-heading" id="coins-title">
        <FormattedMessage id="coins.title" />
      </h2>

      {phase === 'list' && (
        <>
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="coins.intro" />
          </p>

          <label className="dig-field">
            <span><FormattedMessage id="coins.asset" /></span>
            <select data-testid="coins-asset" className="dig-input" value={assetIdx} onChange={(e) => switchAsset(Number(e.target.value))}>
              {assets.map((a, i) => (
                <option key={a.descriptor.key + (a.descriptor.assetId ?? '')} value={i}>
                  {a.descriptor.ticker} — {a.label}
                </option>
              ))}
            </select>
          </label>

          <p className="dig-muted" data-testid="coins-hint" style={{ margin: '4px 0 10px' }}>
            <FormattedMessage id="coins.hint.pick" />
          </p>

          <FourState
            isLoading={coinsQuery.isLoading}
            isError={coinsQuery.isError}
            isEmpty={!coinsQuery.isLoading && !coinsQuery.isError && coins.length === 0}
            onRetry={() => void coinsQuery.refetch()}
            testid="coins"
            loadingId="coins.loading"
            errorId="coins.error"
            emptyId="coins.empty"
          >
            <ul className="dig-coin-list" data-testid="coins-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {coins.map((c) => (
                <li key={c.coinId} data-testid={`coin-row-${c.coinId}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--dig-border)' }}>
                  <input
                    type="checkbox"
                    className="dig-check"
                    data-testid={`coin-select-${c.coinId}`}
                    checked={selected.has(c.coinId)}
                    onChange={() => toggle(c.coinId)}
                    aria-label={intl.formatMessage({ id: 'coins.select' }) + ' ' + shortenAddress(c.coinId)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{formatBaseUnits(Number(c.amount), decimals)} {ticker}</div>
                    <div className="dig-mono dig-muted" style={{ fontSize: '0.78em' }}>
                      {shortenAddress(c.coinId)} · <FormattedMessage id="coins.height" values={{ height: c.confirmedHeight }} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </FourState>

          {coins.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="dig-muted" data-testid="coins-selected" style={{ margin: '0 0 8px' }}>
                <FormattedMessage id="coins.selected" values={{ count: selected.size }} />
              </p>

              <label className="dig-field">
                <span><FormattedMessage id="send.fee" /></span>
                <input data-testid="coins-fee" className="dig-input" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
              </label>

              {/* Split — one coin into N */}
              <div style={{ marginTop: 6 }}>
                <p className="dig-muted" style={{ margin: '0 0 6px' }}><FormattedMessage id="coins.split.hint" /></p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <label className="dig-field" style={{ flex: 1, marginBottom: 0 }}>
                    <span><FormattedMessage id="coins.split.outputs" /></span>
                    <input
                      data-testid="coins-split-outputs"
                      className="dig-input"
                      type="number"
                      min={2}
                      max={50}
                      value={outputs}
                      onChange={(e) => setOutputs(Math.max(2, Math.min(50, Number(e.target.value) || 2)))}
                    />
                  </label>
                  <button type="button" className="dig-btn" data-testid="coins-split" disabled={busy || selected.size !== 1} onClick={() => void doSplit()}>
                    <FormattedMessage id="coins.action.split" />
                  </button>
                </div>
              </div>

              {/* Combine — many coins into one */}
              <div style={{ marginTop: 12 }}>
                <p className="dig-muted" style={{ margin: '0 0 6px' }}><FormattedMessage id="coins.combine.hint" /></p>
                <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="coins-combine" disabled={busy || selected.size < 2} onClick={() => void doCombine()}>
                  <FormattedMessage id="coins.action.combine" />
                </button>
              </div>

              {localError && <p className="dig-error-text" role="alert" data-testid="coins-error" style={{ marginTop: 8 }}>{localError}</p>}
            </div>
          )}

          {onClose && (
            <button type="button" className="dig-link" data-testid="coins-close" onClick={onClose} style={{ marginTop: 12 }}>
              <FormattedMessage id="send.cancel" />
            </button>
          )}
        </>
      )}

      {phase === 'review' && prepared && (
        <div data-testid="coins-review">
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="coins.review.intro" /></p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="coins.title" /></dt>
            <dd data-testid="coins-review-op">
              {prepared.coinOpSummary.kind === 'split' ? (
                <FormattedMessage id="coins.review.split" values={{ outputs: prepared.coinOpSummary.outputCoinCount }} />
              ) : (
                <FormattedMessage id="coins.review.combine" values={{ count: prepared.coinOpSummary.inputCoinCount }} />
              )}
            </dd>
            <dt><FormattedMessage id="coins.review.total" /></dt>
            <dd data-testid="coins-review-total">{formatBaseUnits(Number(prepared.coinOpSummary.total), decimals)} {ticker}</dd>
            <dt><FormattedMessage id="send.review.fee" /></dt>
            <dd data-testid="coins-review-fee">{formatBaseUnits(Number(prepared.coinOpSummary.fee), XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="coins-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="coins.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="coins-back" onClick={() => setPhase('list')}>
            <FormattedMessage id="send.back" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="coins-sending">
          <FormattedMessage id="coins.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="coins-confirmed">
          <p><FormattedMessage id="coins.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="coins-done" onClick={() => { setSelected(new Set()); setPrepared(null); setSpentCoinId(null); setPhase('list'); }}>
            <FormattedMessage id="send.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="coins-failed">
          <p><FormattedMessage id="coins.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="coins-retry" onClick={() => setPhase('list')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}

/** Parse a decimal XCH fee to mojos; 0 on garbage (the vault re-validates). */
function safeMojos(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e12);
}
