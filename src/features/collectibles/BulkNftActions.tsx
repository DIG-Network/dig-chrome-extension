import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { validateSendForm, toBaseUnits, formatBaseUnits } from '@/lib/wallet-view';
import type { WalletNft } from '@/offscreen/nfts';
import {
  usePrepareNftBulkTransferMutation,
  useConfirmNftBulkTransferMutation,
  usePrepareNftBulkBurnMutation,
  useConfirmNftBulkBurnMutation,
} from '@/features/collectibles/collectiblesApi';
import { useLazySendStatusQuery } from '@/features/wallet/custodyApi';
import { nftDisplayName } from '@/features/collectibles/nftDisplay';

const XCH_DECIMALS = 12;
/** The literal the user must type to unlock the burn "Review" button — a distinct, harder-to-miss
 * safeguard than a plain Yes/No step (§171), appropriate for an action with no undo. */
const BURN_CONFIRM_WORD = 'BURN';

type TransferPhase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';
type BurnPhase = 'warn' | 'review' | 'sending' | 'confirmed' | 'failed';

/** Parse a fee (XCH) to mojos; 0 on garbage (mirrors `NftDetail`'s `safeFeeMojos`). */
function safeFeeMojos(fee: string): number {
  try {
    const n = toBaseUnits(fee || '0', XCH_DECIMALS);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * The Collectibles multi-select BULK transfer / destructive-burn flow (#171) — fullscreen-only
 * (§18.11 advanced tier, #145; `CollectiblesPanel` never mounts this on the popup surface). Both
 * modes build ONE spend bundle covering every NFT in `nfts` (`prepareNftBulkTransfer`/
 * `prepareNftBulkBurn`) and reuse the Send state machine's shape:
 *
 * - **transfer**: form (recipient + fee) → review (decoded summary) → confirm (sign + BROADCAST —
 *   the only real spend) → poll → confirmed/retry.
 * - **burn**: an explicit DESTRUCTIVE warning gated by a type-to-confirm field (typing the literal
 *   `BURN` unlocks "Review burn" — a harder-to-miss safeguard than a plain Yes/No for an action with
 *   no undo) → review (destination = the well-known provably-unspendable address) → confirm (sign +
 *   BROADCAST) → poll → confirmed/retry. `confirmNftBulkBurn` is UNREACHABLE without that typed
 *   confirmation — this component never auto-invokes it.
 *
 * Poll uses the shared `sendStatus` (both are ordinary coin spends), `pollMs` injectable for tests.
 */
export function BulkNftActions({
  nfts,
  mode,
  onDone,
  pollMs = 8000,
}: {
  nfts: WalletNft[];
  mode: 'transfer' | 'burn';
  onDone: () => void;
  pollMs?: number;
}) {
  const intl = useIntl();
  const count = nfts.length;
  const launcherIds = nfts.map((n) => n.launcherId);

  const [transferPhase, setTransferPhase] = useState<TransferPhase>('form');
  const [burnPhase, setBurnPhase] = useState<BurnPhase>('warn');
  const [recipient, setRecipient] = useState('');
  const [fee, setFee] = useState('0');
  const [burnFee, setBurnFee] = useState('0');
  const [burnConfirmText, setBurnConfirmText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareTransfer, prepT] = usePrepareNftBulkTransferMutation();
  const [confirmTransfer, confT] = useConfirmNftBulkTransferMutation();
  const [prepareBurn, prepB] = usePrepareNftBulkBurnMutation();
  const [confirmBurn, confB] = useConfirmNftBulkBurnMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const busy = mode === 'transfer' ? prepT.isLoading || confT.isLoading : prepB.isLoading || confB.isLoading;

  async function doPrepareTransfer(): Promise<void> {
    const v = validateSendForm({ address: recipient, amount: '1', fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.fee || intl.formatMessage({ id: 'send.error.address' }));
      return;
    }
    setLocalError(null);
    const res = await prepareTransfer({ launcherIds, recipient, fee: String(safeFeeMojos(fee)) });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setTransferPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'collectibles.bulk.transfer.error.build' }));
    }
  }

  async function doConfirmTransfer(): Promise<void> {
    if (!pendingId) return;
    setTransferPhase('sending');
    const res = await confirmTransfer({ pendingId });
    if ('data' in res && res.data?.spentCoinId) setSpentCoinId(res.data.spentCoinId);
    else setTransferPhase('failed');
  }

  async function doPrepareBurn(): Promise<void> {
    setLocalError(null);
    const res = await prepareBurn({ launcherIds, fee: String(safeFeeMojos(burnFee)) });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setBurnPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'collectibles.bulk.burn.error.build' }));
    }
  }

  async function doConfirmBurn(): Promise<void> {
    if (!pendingId) return;
    setBurnPhase('sending');
    const res = await confirmBurn({ pendingId });
    if ('data' in res && res.data?.spentCoinId) setSpentCoinId(res.data.spentCoinId);
    else setBurnPhase('failed');
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed) — covers both
  // the transfer AND the burn flow (each sets its own terminal phase).
  useEffect(() => {
    const sendingNow = (mode === 'transfer' && transferPhase === 'sending') || (mode === 'burn' && burnPhase === 'sending');
    if (!sendingNow || !spentCoinId) return;
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        if (mode === 'transfer') setTransferPhase('confirmed');
        else setBurnPhase('confirmed');
        clearInterval(timer);
      }
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [mode, transferPhase, burnPhase, spentCoinId, pollMs, pollStatus]);

  if (mode === 'transfer') {
    return (
      <div data-testid="bulk-nft-transfer">
        {transferPhase === 'form' && (
          <form
            data-testid="bulk-transfer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void doPrepareTransfer();
            }}
          >
            <h3 className="dig-heading">
              <FormattedMessage id="collectibles.bulk.transfer.title" values={{ count }} />
            </h3>
            <label className="dig-field">
              <span>
                <FormattedMessage id="nft.transfer.recipient" />
              </span>
              <input
                data-testid="bulk-transfer-recipient"
                className="dig-input dig-mono"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="xch1…"
              />
            </label>
            <label className="dig-field">
              <span>
                <FormattedMessage id="nft.transfer.fee" />
              </span>
              <input data-testid="bulk-transfer-fee" className="dig-input" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
            </label>
            {localError && (
              <p className="dig-error-text" role="alert" data-testid="bulk-transfer-error">
                {localError}
              </p>
            )}
            <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="bulk-transfer-review" disabled={busy}>
              <FormattedMessage id={busy ? 'custody.working' : 'nft.transfer.review'} />
            </button>
            <button type="button" className="dig-link" data-testid="bulk-transfer-cancel" onClick={onDone}>
              <FormattedMessage id="nft.transfer.cancel" />
            </button>
          </form>
        )}

        {transferPhase === 'review' && (
          <div data-testid="bulk-transfer-review-panel">
            <p className="dig-muted" style={{ marginTop: 0 }}>
              <FormattedMessage id="collectibles.bulk.transfer.review.intro" values={{ count }} />
            </p>
            <dl className="dig-summary">
              <dt>
                <FormattedMessage id="collectibles.bulk.transfer.review.nfts" values={{ count }} />
              </dt>
              <dd className="dig-mono" data-testid="bulk-transfer-review-list">
                {nfts.map(nftDisplayName).join(', ')}
              </dd>
              <dt>
                <FormattedMessage id="nft.transfer.review.recipient" />
              </dt>
              <dd className="dig-mono" data-testid="bulk-transfer-review-recipient">
                {recipient}
              </dd>
              <dt>
                <FormattedMessage id="nft.transfer.review.fee" />
              </dt>
              <dd data-testid="bulk-transfer-review-fee">{formatBaseUnits(safeFeeMojos(fee), XCH_DECIMALS)} XCH</dd>
            </dl>
            <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="bulk-transfer-confirm" onClick={() => void doConfirmTransfer()} disabled={busy}>
              <FormattedMessage id="nft.transfer.confirm" />
            </button>
            <button type="button" className="dig-link" data-testid="bulk-transfer-back" onClick={() => setTransferPhase('form')}>
              <FormattedMessage id="nft.transfer.back" />
            </button>
          </div>
        )}

        {transferPhase === 'sending' && (
          <div className="dig-state" data-state="loading" role="status" data-testid="bulk-transfer-sending">
            <FormattedMessage id="collectibles.bulk.transfer.sending" values={{ count }} />
          </div>
        )}
        {transferPhase === 'confirmed' && (
          <div className="dig-state" data-state="success" role="status" data-testid="bulk-transfer-confirmed">
            <p>
              <FormattedMessage id="collectibles.bulk.transfer.confirmed" values={{ count }} />
            </p>
            <button type="button" className="dig-btn dig-btn--block" data-testid="bulk-transfer-done" onClick={onDone}>
              <FormattedMessage id="nft.transfer.done" />
            </button>
          </div>
        )}
        {transferPhase === 'failed' && (
          <div className="dig-state" data-state="error" role="alert" data-testid="bulk-transfer-failed">
            <p>
              <FormattedMessage id="collectibles.bulk.transfer.failed" />
            </p>
            <button type="button" className="dig-btn dig-btn--block" data-testid="bulk-transfer-retry" onClick={() => setTransferPhase('form')}>
              <FormattedMessage id="state.retry" />
            </button>
          </div>
        )}
      </div>
    );
  }

  // mode === 'burn'
  const confirmMatches = burnConfirmText.trim().toUpperCase() === BURN_CONFIRM_WORD;
  return (
    <div data-testid="bulk-nft-burn">
      {burnPhase === 'warn' && (
        <form
          data-testid="bulk-burn-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmMatches) void doPrepareBurn();
          }}
        >
          <h3 className="dig-heading">
            <FormattedMessage id="collectibles.bulk.burn.title" values={{ count }} />
          </h3>
          <p className="dig-error-text" role="alert" data-testid="bulk-burn-warning">
            <FormattedMessage id="collectibles.bulk.burn.warning" values={{ count }} />
          </p>
          <label className="dig-field">
            <span>
              <FormattedMessage id="collectibles.bulk.burn.confirmPrompt" />
            </span>
            <input
              data-testid="bulk-burn-confirm-text"
              className="dig-input dig-mono"
              value={burnConfirmText}
              onChange={(e) => setBurnConfirmText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={intl.formatMessage({ id: 'collectibles.bulk.burn.confirmPlaceholder' })}
            />
          </label>
          <label className="dig-field">
            <span>
              <FormattedMessage id="nft.transfer.fee" />
            </span>
            <input data-testid="bulk-burn-fee" className="dig-input" value={burnFee} onChange={(e) => setBurnFee(e.target.value)} inputMode="decimal" />
          </label>
          {burnConfirmText.length > 0 && !confirmMatches && (
            <p className="dig-error-text" role="alert" data-testid="bulk-burn-confirm-mismatch">
              <FormattedMessage id="collectibles.bulk.burn.confirmMismatch" />
            </p>
          )}
          {localError && (
            <p className="dig-error-text" role="alert" data-testid="bulk-burn-error">
              {localError}
            </p>
          )}
          <button type="submit" className="dig-btn dig-btn--danger dig-btn--block" data-testid="bulk-burn-review" disabled={busy || !confirmMatches}>
            <FormattedMessage id={busy ? 'custody.working' : 'collectibles.bulk.burn.review'} />
          </button>
          <button type="button" className="dig-link" data-testid="bulk-burn-cancel" onClick={onDone}>
            <FormattedMessage id="collectibles.bulk.burn.cancel" />
          </button>
        </form>
      )}

      {burnPhase === 'review' && (
        <div data-testid="bulk-burn-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="collectibles.bulk.burn.review.intro" values={{ count }} />
          </p>
          <dl className="dig-summary">
            <dt>
              <FormattedMessage id="collectibles.bulk.burn.review.nfts" values={{ count }} />
            </dt>
            <dd className="dig-mono" data-testid="bulk-burn-review-list">
              {nfts.map(nftDisplayName).join(', ')}
            </dd>
            <dt>
              <FormattedMessage id="collectibles.bulk.burn.review.destination" />
            </dt>
            <dd data-testid="bulk-burn-review-destination">
              <FormattedMessage id="collectibles.bulk.burn.review.destinationValue" />
            </dd>
            <dt>
              <FormattedMessage id="nft.transfer.review.fee" />
            </dt>
            <dd data-testid="bulk-burn-review-fee">{formatBaseUnits(safeFeeMojos(burnFee), XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--danger dig-btn--block" data-testid="bulk-burn-confirm" onClick={() => void doConfirmBurn()} disabled={busy}>
            <FormattedMessage id="collectibles.bulk.burn.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="bulk-burn-back" onClick={() => setBurnPhase('warn')}>
            <FormattedMessage id="nft.transfer.back" />
          </button>
        </div>
      )}

      {burnPhase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="bulk-burn-sending">
          <FormattedMessage id="collectibles.bulk.burn.sending" values={{ count }} />
        </div>
      )}
      {burnPhase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="bulk-burn-confirmed">
          <p>
            <FormattedMessage id="collectibles.bulk.burn.confirmed" values={{ count }} />
          </p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="bulk-burn-done" onClick={onDone}>
            <FormattedMessage id="nft.transfer.done" />
          </button>
        </div>
      )}
      {burnPhase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="bulk-burn-failed">
          <p>
            <FormattedMessage id="collectibles.bulk.burn.failed" />
          </p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="bulk-burn-retry" onClick={() => setBurnPhase('warn')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </div>
  );
}
