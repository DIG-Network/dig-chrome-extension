import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatBaseUnits } from '@/lib/wallet-view';
import { usePrepareNftMintMutation, useConfirmNftMintMutation } from '@/features/collectibles/collectiblesApi';
import { useLazySendStatusQuery } from '@/features/wallet/custodyApi';
import { validateMintForm, basisPointsToPercentLabel, EMPTY_MINT_FORM, type MintForm, type MintErrors } from '@/features/collectibles/nftMint';
import type { NftMintSummary } from '@/offscreen/nfts';

const XCH_DECIMALS = 12;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/**
 * Mint a new NFT (#92). A plain-language form (media/metadata/license URLs + optional integrity hashes,
 * royalty %, optional royalty payout address, network fee) → a pre-sign review decoded FROM the built
 * spend (what will be minted + the fee) → confirm (sign in the offscreen vault + BROADCAST — the only
 * real spend) → poll to Transferred/retry. Poll reuses the shared `sendStatus` (a mint is a coin spend).
 * The new NFT then appears in Collectibles (the mutation invalidates the `Collectibles` cache). The
 * decrypted key never leaves the vault. `pollMs` is injectable for tests.
 */
export function MintNft({ onDone, pollMs = 8000 }: { onDone: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('form');
  const [form, setForm] = useState<MintForm>(EMPTY_MINT_FORM);
  const [errors, setErrors] = useState<MintErrors>({});
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [summary, setSummary] = useState<NftMintSummary | null>(null);
  const [launcherId, setLauncherId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);

  const [prepareMint, prep] = usePrepareNftMintMutation();
  const [confirmMint, conf] = useConfirmNftMintMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const set = (field: keyof MintForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function doPrepare() {
    const v = validateMintForm(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBuildError(null);
    const res = await prepareMint({ nftMint: v.params });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setSummary(res.data.nftMintSummary);
      setLauncherId(res.data.launcherId);
      setPhase('review');
    } else {
      setBuildError(intl.formatMessage({ id: 'mint.error.build' }));
    }
  }

  async function doConfirm() {
    if (!pendingId) return;
    setPhase('sending');
    const res = await confirmMint({ pendingId });
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
  const err = (field: keyof MintForm): string | null => (errors[field] ? intl.formatMessage({ id: errors[field] as string }) : null);

  return (
    <section className="dig-card" data-testid="mint-nft" aria-labelledby="mint-nft-title">
      <button type="button" className="dig-link" data-testid="mint-back" onClick={onDone}>
        <FormattedMessage id="mint.back" />
      </button>
      <h2 className="dig-heading" id="mint-nft-title" style={{ marginTop: 8 }}>
        <FormattedMessage id="mint.title" />
      </h2>

      {phase === 'form' && (
        <form
          data-testid="mint-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="mint.intro" />
          </p>

          <MintField label="mint.media" hint="mint.media.hint" testid="mint-media" value={form.mediaUri} onChange={set('mediaUri')} error={err('mediaUri')} placeholder="https://…" />
          <MintField label="mint.mediaHash" testid="mint-media-hash" value={form.mediaHash} onChange={set('mediaHash')} error={err('mediaHash')} mono placeholder="sha256 (hex)" />
          <MintField label="mint.metadata" hint="mint.metadata.hint" testid="mint-metadata" value={form.metadataUri} onChange={set('metadataUri')} error={err('metadataUri')} placeholder="https://…/metadata.json" />
          <MintField label="mint.metadataHash" testid="mint-metadata-hash" value={form.metadataHash} onChange={set('metadataHash')} error={err('metadataHash')} mono placeholder="sha256 (hex)" />
          <MintField label="mint.license" testid="mint-license" value={form.licenseUri} onChange={set('licenseUri')} error={err('licenseUri')} placeholder="https://…" />
          <MintField label="mint.licenseHash" testid="mint-license-hash" value={form.licenseHash} onChange={set('licenseHash')} error={err('licenseHash')} mono placeholder="sha256 (hex)" />
          <MintField label="mint.royalty" hint="mint.royalty.hint" testid="mint-royalty" value={form.royaltyPercent} onChange={set('royaltyPercent')} error={err('royaltyPercent')} inputMode="decimal" placeholder="0" />
          <MintField label="mint.royaltyAddress" hint="mint.royaltyAddress.hint" testid="mint-royalty-address" value={form.royaltyAddress} onChange={set('royaltyAddress')} error={err('royaltyAddress')} mono placeholder="xch1… (optional)" />
          <MintField label="mint.fee" testid="mint-fee" value={form.fee} onChange={set('fee')} error={err('fee')} inputMode="decimal" placeholder="0" />

          {buildError && <p className="dig-error-text" role="alert" data-testid="mint-build-error">{buildError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="mint-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'mint.review'} />
          </button>
        </form>
      )}

      {phase === 'review' && summary && (
        <div data-testid="mint-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="mint.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="mint.review.media" /></dt>
            <dd className="dig-mono" data-testid="mint-review-media" style={{ wordBreak: 'break-all' }}>{summary.dataUris[0]}</dd>
            {summary.metadataUris[0] && (
              <>
                <dt><FormattedMessage id="mint.review.metadata" /></dt>
                <dd className="dig-mono" style={{ wordBreak: 'break-all' }}>{summary.metadataUris[0]}</dd>
              </>
            )}
            <dt><FormattedMessage id="mint.review.royalty" /></dt>
            <dd data-testid="mint-review-royalty">{basisPointsToPercentLabel(summary.royaltyBasisPoints)}</dd>
            <dt><FormattedMessage id="mint.review.fee" /></dt>
            <dd data-testid="mint-review-fee">{formatBaseUnits(summary.fee, XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="mint-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="mint.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="mint-edit" onClick={() => setPhase('form')}>
            <FormattedMessage id="mint.edit" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="mint-sending">
          <FormattedMessage id="mint.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="mint-confirmed">
          <p><FormattedMessage id="mint.confirmed" /></p>
          {launcherId && <p className="dig-mono" data-testid="mint-launcher-id" style={{ wordBreak: 'break-all', fontSize: 11 }}>{launcherId}</p>}
          <button type="button" className="dig-btn dig-btn--block" data-testid="mint-done" onClick={onDone}>
            <FormattedMessage id="mint.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="mint-failed">
          <p><FormattedMessage id="mint.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="mint-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
  );
}

/** One labelled mint input with an optional hint line + inline error. */
function MintField({
  label,
  hint,
  testid,
  value,
  onChange,
  error,
  placeholder,
  mono = false,
  inputMode,
}: {
  label: string;
  hint?: string;
  testid: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  placeholder?: string;
  mono?: boolean;
  inputMode?: 'decimal';
}) {
  return (
    <label className="dig-field">
      <span><FormattedMessage id={label} /></span>
      {hint && <span className="dig-muted" style={{ fontWeight: 400, fontSize: 11 }}><FormattedMessage id={hint} /></span>}
      <input
        data-testid={testid}
        className={mono ? 'dig-input dig-mono' : 'dig-input'}
        value={value}
        onChange={onChange}
        autoComplete="off"
        spellCheck={false}
        {...(placeholder ? { placeholder } : {})}
        {...(inputMode ? { inputMode } : {})}
      />
      {error && <span className="dig-error-text" role="alert" data-testid={`${testid}-error`}>{error}</span>}
    </label>
  );
}
