import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ExternalLink } from '@/components/ExternalLink';
import { validateSendForm, toBaseUnits, formatBaseUnits } from '#shared/wallet-view.mjs';
import type { WalletNft } from '@/offscreen/nfts';
import { usePrepareNftTransferMutation, useConfirmNftTransferMutation } from '@/features/collectibles/collectiblesApi';
import { useLazySendStatusQuery } from '@/features/wallet/custodyApi';
import {
  nftDisplayName,
  editionLabel,
  royaltyPercentLabel,
  nftImageSrc,
  nftExternalImageUrl,
  nftMonogram,
  shortHex,
} from '@/features/collectibles/nftDisplay';

const XCH_DECIMALS = 12;

type Phase = 'detail' | 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * One NFT's detail view + its transfer flow (§18.11). The detail shows the (CSP-safe) preview,
 * on-chain data (launcher id, edition, royalty, collection), and the metadata/license links. Transfer
 * reuses the Send state machine: form (recipient + fee) → review (decoded summary) → confirm (sign +
 * BROADCAST — the only real spend) → optimistic "Transferring…" → poll → Transferred / retry. Poll
 * uses the shared `sendStatus` (an NFT transfer is a coin spend). `pollMs` is injectable for tests.
 */
export function NftDetail({ nft, onBack, pollMs = 8000 }: { nft: WalletNft; onBack: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('detail');
  const [recipient, setRecipient] = useState('');
  const [fee, setFee] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareTransfer, prep] = usePrepareNftTransferMutation();
  const [confirmTransfer, conf] = useConfirmNftTransferMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const imageSrc = nftImageSrc(nft);
  const externalImage = nftExternalImageUrl(nft);
  const edition = editionLabel(nft);

  async function doPrepare() {
    const v = validateSendForm({ address: recipient, amount: '1', fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.fee || intl.formatMessage({ id: 'send.error.address' }));
      return;
    }
    setLocalError(null);
    const feeMojos = safeFeeMojos(fee);
    const res = await prepareTransfer({ launcherId: nft.launcherId, recipient, fee: String(feeMojos) });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'nft.transfer.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmTransfer({ pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setPhase('failed');
    }
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed).
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

  const busy = prep.isLoading || conf.isLoading;

  return (
    <section className="dig-card" data-testid="nft-detail" aria-labelledby="nft-detail-title">
      <button type="button" className="dig-link" data-testid="nft-detail-back" onClick={onBack}>
        <FormattedMessage id="nft.detail.back" />
      </button>

      <div className="dig-nft-hero" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: '8px 0 14px' }}>
        <NftMedia nft={nft} imageSrc={imageSrc} big />
        <div style={{ minWidth: 0 }}>
          <h2 className="dig-heading dig-mono" id="nft-detail-title" style={{ margin: 0, wordBreak: 'break-all' }}>
            {nftDisplayName(nft)}
          </h2>
          {edition && <p className="dig-muted" style={{ margin: '2px 0 0' }}>{edition}</p>}
        </div>
      </div>

      {phase === 'detail' && (
        <>
          <dl className="dig-summary">
            <dt><FormattedMessage id="nft.detail.launcherId" /></dt>
            <dd className="dig-mono" data-testid="nft-launcher-id" style={{ wordBreak: 'break-all' }}>{nft.launcherId}</dd>
            <dt><FormattedMessage id="nft.detail.edition" /></dt>
            <dd data-testid="nft-edition">{nft.editionNumber}{nft.editionTotal !== '1' ? ` / ${nft.editionTotal}` : ''}</dd>
            <dt><FormattedMessage id="nft.detail.royalty" /></dt>
            <dd data-testid="nft-royalty">{royaltyPercentLabel(nft.royaltyBasisPoints)}</dd>
            <dt><FormattedMessage id="nft.detail.collection" /></dt>
            <dd className="dig-mono" data-testid="nft-collection">
              {nft.collectionId ? shortHex(nft.collectionId, 8, 6) : intl.formatMessage({ id: 'collectibles.collection.ungrouped' })}
            </dd>
          </dl>

          {(externalImage || nft.metadataUris[0] || nft.licenseUris[0]) && (
            <ul className="dig-link-list" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {externalImage && (
                <li><ExternalLink href={externalImage} testid="nft-view-image"><FormattedMessage id="nft.detail.viewImage" /></ExternalLink></li>
              )}
              {nft.metadataUris[0] && (
                <li><ExternalLink href={nft.metadataUris[0]} testid="nft-view-metadata"><FormattedMessage id="nft.detail.viewMetadata" /></ExternalLink></li>
              )}
              {nft.licenseUris[0] && (
                <li><ExternalLink href={nft.licenseUris[0]} testid="nft-view-license"><FormattedMessage id="nft.detail.viewLicense" /></ExternalLink></li>
              )}
            </ul>
          )}

          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-transfer-open" onClick={() => setPhase('form')}>
            <FormattedMessage id="nft.transfer.button" />
          </button>
        </>
      )}

      {phase === 'form' && (
        <form
          data-testid="nft-transfer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <h3 className="dig-heading"><FormattedMessage id="nft.transfer.title" /></h3>
          <label className="dig-field">
            <span><FormattedMessage id="nft.transfer.recipient" /></span>
            <input data-testid="nft-transfer-recipient" className="dig-input dig-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" />
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="nft.transfer.fee" /></span>
            <input data-testid="nft-transfer-fee" className="dig-input" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
          </label>
          {localError && <p className="dig-error-text" role="alert" data-testid="nft-transfer-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-transfer-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'nft.transfer.review'} />
          </button>
          <button type="button" className="dig-link" data-testid="nft-transfer-cancel" onClick={() => setPhase('detail')}>
            <FormattedMessage id="nft.transfer.cancel" />
          </button>
        </form>
      )}

      {phase === 'review' && (
        <div data-testid="nft-transfer-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="nft.transfer.review.intro" /></p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="nft.transfer.review.nft" /></dt>
            <dd className="dig-mono">{nftDisplayName(nft)}</dd>
            <dt><FormattedMessage id="nft.transfer.review.recipient" /></dt>
            <dd className="dig-mono" data-testid="nft-review-recipient">{recipient}</dd>
            <dt><FormattedMessage id="nft.transfer.review.fee" /></dt>
            <dd data-testid="nft-review-fee">{formatBaseUnits(safeFeeMojos(fee), XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-transfer-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="nft.transfer.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="nft-transfer-back" onClick={() => setPhase('form')}>
            <FormattedMessage id="nft.transfer.back" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="nft-transfer-sending">
          <FormattedMessage id="nft.transfer.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="nft-transfer-confirmed">
          <p><FormattedMessage id="nft.transfer.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="nft-transfer-done" onClick={onBack}>
            <FormattedMessage id="nft.transfer.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="nft-transfer-failed">
          <p><FormattedMessage id="nft.transfer.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="nft-transfer-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}

/** The NFT preview: an inline `data:` image where CSP allows, else a deterministic monogram tile. */
export function NftMedia({ nft, imageSrc, big = false }: { nft: WalletNft; imageSrc: string | null; big?: boolean }) {
  const side = big ? 96 : '100%';
  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt=""
        data-testid="nft-image"
        style={{ width: side, height: big ? 96 : 'auto', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 10, background: 'var(--dig-surface, #f2f2f7)' }}
      />
    );
  }
  return (
    <div
      data-testid="nft-monogram"
      aria-hidden="true"
      style={{
        width: side,
        aspectRatio: '1 / 1',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 10,
        fontWeight: 700,
        fontSize: big ? 28 : 20,
        color: '#fff',
        background: 'linear-gradient(135deg, #7a3dff, #c13de0)',
      }}
    >
      {nftMonogram(nft)}
    </div>
  );
}

/** Parse the fee (XCH) to mojos; 0 on garbage (validation catches bad input in the form). */
function safeFeeMojos(fee: string): number {
  try {
    const n = toBaseUnits(fee || '0', XCH_DECIMALS);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
