import { Fragment, useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ExternalLink } from '@/components/ExternalLink';
import { FourState } from '@/components/FourState';
import { ViewHeader } from '@/components/ViewHeader';
import { validateSendForm, toBaseUnits, formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import { popOutToFullpage } from '@/lib/popout';
import type { WalletNft } from '@/offscreen/nfts';
import { usePrepareNftTransferMutation, useConfirmNftTransferMutation, usePrepareNftDidAssignMutation, useConfirmNftDidAssignMutation } from '@/features/collectibles/collectiblesApi';
import { useListDidsQuery } from '@/features/identity/identityApi';
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
import { NftImageLightbox } from '@/features/collectibles/NftImageLightbox';
import { useNftMetadata } from '@/features/collectibles/useNftMetadata';
import { useCachedNftImageSrc } from '@/features/collectibles/useCachedNftImageSrc';

const XCH_DECIMALS = 12;

type Phase = 'detail' | 'form' | 'review' | 'sending' | 'confirmed' | 'failed' | 'assignPick' | 'assignReview' | 'assignSending' | 'assignConfirmed' | 'assignFailed';

/**
 * One NFT's detail view + its transfer + DID-owner-assignment flows (§18.11 / §18.17, #93). The
 * detail shows the (CSP-safe) preview, on-chain data (launcher id, edition, royalty, collection —
 * the assigned owner DID's launcher id, when set), and the metadata/license links. Transfer AND
 * assigning a DID owner are ADVANCED → fullscreen only (#145); the popup shows an "open full screen"
 * affordance instead of either. Both flows reuse the Send state machine: pick/form → review (decoded
 * summary) → confirm (sign + BROADCAST — the only real spend) → poll → confirmed/retry. Poll uses the
 * shared `sendStatus` (both are coin spends). `pollMs` is injectable for tests.
 */
export function NftDetail({ nft, isFull = false, onBack, pollMs = 8000 }: { nft: WalletNft; isFull?: boolean; onBack: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('detail');
  const [recipient, setRecipient] = useState('');
  const [fee, setFee] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [selectedDidLauncherId, setSelectedDidLauncherId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [prepareTransfer, prep] = usePrepareNftTransferMutation();
  const [confirmTransfer, conf] = useConfirmNftTransferMutation();
  const dids = useListDidsQuery(undefined, { skip: phase !== 'assignPick' });
  const [prepareAssign, assignPrep] = usePrepareNftDidAssignMutation();
  const [confirmAssign, assignConf] = useConfirmNftDidAssignMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const imageSrc = nftImageSrc(nft);
  const externalImage = nftExternalImageUrl(nft);
  const edition = editionLabel(nft);
  const { metadata } = useNftMetadata(nft);
  const displayName = metadata?.name ?? nftDisplayName(nft);

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

  async function doPrepareAssign() {
    if (!selectedDidLauncherId) {
      setAssignError(intl.formatMessage({ id: 'nft.assign.error.pick' }));
      return;
    }
    setAssignError(null);
    const res = await prepareAssign({ launcherId: nft.launcherId, didLauncherId: selectedDidLauncherId });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setPhase('assignReview');
    } else {
      setAssignError(intl.formatMessage({ id: 'nft.assign.error.build' }));
    }
  }

  async function doConfirmAssign() {
    if (!pendingId) return;
    setPhase('assignSending');
    const res = await confirmAssign({ pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setPhase('assignFailed');
    }
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed) — covers both
  // the transfer AND the DID-assignment flows (each sets its own terminal phase).
  useEffect(() => {
    if ((phase !== 'sending' && phase !== 'assignSending') || !spentCoinId) return;
    const doneWith = phase === 'sending' ? 'confirmed' : 'assignConfirmed';
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        setPhase(doneWith);
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
    <div data-testid="nft-detail">
      <ViewHeader onBack={onBack} backLabel={<FormattedMessage id="nft.detail.back" />} backTestId="nft-detail-back" />
      <section className="dig-card" aria-labelledby="nft-detail-title">
      <div className="dig-nft-hero" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: '8px 0 14px' }}>
        <NftMedia nft={nft} imageSrc={imageSrc} big enableLightbox />
        <div style={{ minWidth: 0 }}>
          <h2 className={metadata?.name ? 'dig-heading' : 'dig-heading dig-mono'} id="nft-detail-title" style={{ margin: 0, wordBreak: 'break-all' }}>
            {displayName}
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
            <dd className={metadata?.collection?.name ? undefined : 'dig-mono'} data-testid="nft-collection">
              {metadata?.collection?.name ??
                (nft.collectionId ? shortHex(nft.collectionId, 8, 6) : intl.formatMessage({ id: 'collectibles.collection.ungrouped' }))}
            </dd>
          </dl>

          {metadata?.description && (
            <p className="dig-muted" data-testid="nft-detail-description" style={{ margin: '0 0 12px' }}>
              {metadata.description}
            </p>
          )}

          {metadata && metadata.attributes.length > 0 && (
            <div data-testid="nft-detail-attributes" style={{ margin: '0 0 12px' }}>
              <h3 className="dig-heading" style={{ fontSize: 14, margin: '0 0 6px' }}>
                <FormattedMessage id="nft.detail.attributes" />
              </h3>
              <dl className="dig-summary">
                {metadata.attributes.map((attr, i) => (
                  <Fragment key={`${attr.traitType}-${i}`}>
                    <dt>{attr.traitType}</dt>
                    <dd>{attr.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          )}

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

          {isFull ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-transfer-open" onClick={() => setPhase('form')}>
                <FormattedMessage id="nft.transfer.button" />
              </button>
              <button type="button" className="dig-btn dig-btn--block" data-testid="nft-assign-open" onClick={() => setPhase('assignPick')}>
                <FormattedMessage id="nft.assign.button" />
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-transfer-open" onClick={() => setPhase('form')}>
                <FormattedMessage id="nft.transfer.button" />
              </button>
              <button type="button" className="dig-link" data-testid="nft-assign-fullscreen" onClick={() => void popOutToFullpage('#wallet/collectibles', true)}>
                <FormattedMessage id="nft.assign.openFullscreen" />
              </button>
            </div>
          )}
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

      {phase === 'assignPick' && (
        <div data-testid="nft-assign-pick">
          <h3 className="dig-heading"><FormattedMessage id="nft.assign.title" /></h3>
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="nft.assign.intro" /></p>
          <FourState
            isLoading={dids.isLoading}
            isError={dids.isError}
            isEmpty={!dids.isLoading && !dids.isError && (dids.data?.dids.length ?? 0) === 0}
            onRetry={() => void dids.refetch()}
            testid="nft-assign-dids"
            loadingId="nft.assign.loading"
            errorId="nft.assign.error.load"
            emptyId="nft.assign.empty"
          >
            <ul className="dig-did-list" data-testid="nft-assign-did-list" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'grid', gap: 8 }}>
              {(dids.data?.dids ?? []).map((did) => (
                <li key={did.launcherId}>
                  <button
                    type="button"
                    className={selectedDidLauncherId === did.launcherId ? 'dig-btn dig-btn--primary' : 'dig-btn'}
                    data-testid={`nft-assign-did-${did.launcherId}`}
                    onClick={() => setSelectedDidLauncherId(did.launcherId)}
                    style={{ display: 'block', width: '100%', textAlign: 'left' }}
                  >
                    <span className="dig-mono">{did.profileName || shortenAddress(did.launcherId, 10, 8)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </FourState>
          {assignError && <p className="dig-error-text" role="alert" data-testid="nft-assign-error">{assignError}</p>}
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-assign-review" onClick={() => void doPrepareAssign()} disabled={assignPrep.isLoading}>
            <FormattedMessage id={assignPrep.isLoading ? 'custody.working' : 'nft.assign.review'} />
          </button>
          <button type="button" className="dig-link" data-testid="nft-assign-cancel" onClick={() => setPhase('detail')}>
            <FormattedMessage id="nft.assign.cancel" />
          </button>
        </div>
      )}

      {phase === 'assignReview' && (
        <div data-testid="nft-assign-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="nft.assign.review.intro" /></p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="nft.assign.review.nft" /></dt>
            <dd className="dig-mono">{nftDisplayName(nft)}</dd>
            <dt><FormattedMessage id="nft.assign.review.did" /></dt>
            <dd className="dig-mono" data-testid="nft-assign-review-did">{selectedDidLauncherId ? shortenAddress(selectedDidLauncherId, 10, 8) : ''}</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="nft-assign-confirm" onClick={() => void doConfirmAssign()} disabled={assignConf.isLoading}>
            <FormattedMessage id="nft.assign.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="nft-assign-back" onClick={() => setPhase('assignPick')}>
            <FormattedMessage id="nft.assign.back" />
          </button>
        </div>
      )}

      {phase === 'assignSending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="nft-assign-sending">
          <FormattedMessage id="nft.assign.sending" />
        </div>
      )}
      {phase === 'assignConfirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="nft-assign-confirmed">
          <p><FormattedMessage id="nft.assign.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="nft-assign-done" onClick={onBack}>
            <FormattedMessage id="nft.assign.done" />
          </button>
        </div>
      )}
      {phase === 'assignFailed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="nft-assign-failed">
          <p><FormattedMessage id="nft.assign.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="nft-assign-retry" onClick={() => setPhase('assignPick')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
      </section>
    </div>
  );
}

/**
 * The NFT preview: the resolved + locally-cached image (§ `useCachedNftImageSrc`, #150/#159) when one
 * is known AND has not failed to load, else a deterministic monogram tile. An image that 404s / times
 * out / errors (at fetch time, or an `<img onerror>` for a cached-but-corrupt blob) falls back to the
 * monogram (`erroredSrc`) rather than showing a broken-image icon.
 *
 * `enableLightbox` (#173, opt-in — the NftDetail hero passes it; the Collectibles grid tile does not,
 * since its own wrapping `<button>` already navigates to the detail view on click) wraps the resolved
 * image in a click target that opens an {@link NftImageLightbox} showing the SAME resolved src — no
 * re-fetch. It only ever applies to a REAL image (this branch), never the monogram fallback below, so
 * a "no art yet" tile can't open an empty lightbox.
 */
export function NftMedia({ nft, imageSrc, big = false, enableLightbox = false }: { nft: WalletNft; imageSrc: string | null; big?: boolean; enableLightbox?: boolean }) {
  const intl = useIntl();
  const cachedSrc = useCachedNftImageSrc(imageSrc);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const side = big ? 96 : '100%';
  if (cachedSrc && cachedSrc !== erroredSrc) {
    const img = (
      <img
        src={cachedSrc}
        alt=""
        data-testid="nft-image"
        onError={() => setErroredSrc(cachedSrc)}
        style={{ width: side, height: big ? 96 : 'auto', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 10, background: 'var(--dig-surface, #f2f2f7)' }}
      />
    );
    if (!enableLightbox) return img;
    return (
      <>
        <button
          type="button"
          className="dig-nft-media-trigger"
          data-testid="nft-image-trigger"
          aria-label={intl.formatMessage({ id: 'nft.lightbox.trigger' })}
          onClick={() => setLightboxOpen(true)}
        >
          {img}
        </button>
        {lightboxOpen && (
          <NftImageLightbox
            src={cachedSrc}
            label={intl.formatMessage({ id: 'nft.lightbox.title' }, { name: nftDisplayName(nft) })}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
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
