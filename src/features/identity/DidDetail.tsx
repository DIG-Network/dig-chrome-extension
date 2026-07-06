import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { validateSendForm, toBaseUnits, formatBaseUnits, shortenAddress } from '@/lib/wallet-view';
import { popOutToFullpage } from '@/lib/popout';
import type { WalletDid } from '@/offscreen/dids';
import {
  usePrepareDidTransferMutation,
  useConfirmDidTransferMutation,
  usePrepareDidProfileUpdateMutation,
  useConfirmDidProfileUpdateMutation,
} from '@/features/identity/identityApi';
import { useLazySendStatusQuery } from '@/features/wallet/custodyApi';

const XCH_DECIMALS = 12;
const PROFILE_NAME_MAX = 128;

type Phase = 'detail' | 'form' | 'review' | 'sending' | 'confirmed' | 'failed' | 'profileForm' | 'profileReview' | 'profileSending' | 'profileConfirmed' | 'profileFailed';

/**
 * One DID's detail view (on-chain state) + its transfer + profile-update flows (§18.17, #93). The
 * detail is view-only (incl. the profile name, when set) and renders on BOTH surfaces;
 * **transferring + editing the profile are ADVANCED → fullscreen only (#145)** — the popup shows an
 * "open full screen" affordance instead of either form. Both flows reuse the Send state machine: form
 * → review (decoded summary) → confirm (sign + BROADCAST — the only real spend) → poll →
 * confirmed/retry. Poll uses the shared `sendStatus` (both are coin spends). `pollMs` is injectable
 * for tests.
 */
export function DidDetail({ did, isFull, onBack, pollMs = 8000 }: { did: WalletDid; isFull: boolean; onBack: () => void; pollMs?: number }) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('detail');
  const [recipient, setRecipient] = useState('');
  const [fee, setFee] = useState('0');
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState(did.profileName ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);

  const [prepareTransfer, prep] = usePrepareDidTransferMutation();
  const [confirmTransfer, conf] = useConfirmDidTransferMutation();
  const [prepareProfile, profilePrep] = usePrepareDidProfileUpdateMutation();
  const [confirmProfile, profileConf] = useConfirmDidProfileUpdateMutation();
  const [pollStatus] = useLazySendStatusQuery();

  async function doPrepare() {
    const v = validateSendForm({ address: recipient, amount: '1', fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.fee || intl.formatMessage({ id: 'send.error.address' }));
      return;
    }
    setLocalError(null);
    const feeMojos = safeFeeMojos(fee);
    const res = await prepareTransfer({ launcherId: did.launcherId, recipient, fee: String(feeMojos) });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: 'did.transfer.error.build' }));
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

  async function doPrepareProfile() {
    const trimmed = profileName.trim();
    if (!trimmed || trimmed.length > PROFILE_NAME_MAX) {
      setProfileError(intl.formatMessage({ id: 'did.profile.error.name' }));
      return;
    }
    setProfileError(null);
    const res = await prepareProfile({ launcherId: did.launcherId, profileName: trimmed });
    if ('data' in res && res.data?.pendingId) {
      setPendingId(res.data.pendingId);
      setPhase('profileReview');
    } else {
      setProfileError(intl.formatMessage({ id: 'did.profile.error.build' }));
    }
  }

  async function doConfirmProfile() {
    if (!pendingId) return;
    setPhase('profileSending');
    const res = await confirmProfile({ pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
    } else {
      setPhase('profileFailed');
    }
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed) — covers both
  // the transfer AND the profile-update flows (each sets its own terminal phase).
  useEffect(() => {
    if ((phase !== 'sending' && phase !== 'profileSending') || !spentCoinId) return;
    const doneWith = phase === 'sending' ? 'confirmed' : 'profileConfirmed';
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
  const profileBusy = profilePrep.isLoading || profileConf.isLoading;

  return (
    <section className="dig-card" data-testid="did-detail" aria-labelledby="did-detail-title">
      <button type="button" className="dig-link" data-testid="did-detail-back" onClick={onBack}>
        <FormattedMessage id="did.detail.back" />
      </button>

      <h2 className="dig-heading dig-mono" id="did-detail-title" style={{ margin: '8px 0 14px', wordBreak: 'break-all' }}>
        {shortenAddress(did.launcherId, 10, 8)}
      </h2>

      {phase === 'detail' && (
        <>
          <dl className="dig-summary">
            <dt><FormattedMessage id="did.detail.profileName" /></dt>
            <dd data-testid="did-profile-name">
              {did.profileName || <span className="dig-muted"><FormattedMessage id="did.detail.profileName.unset" /></span>}
            </dd>
            <dt><FormattedMessage id="did.detail.launcherId" /></dt>
            <dd className="dig-mono" data-testid="did-launcher-id" style={{ wordBreak: 'break-all' }}>{did.launcherId}</dd>
            <dt><FormattedMessage id="did.detail.recovery" /></dt>
            <dd data-testid="did-recovery">
              {did.recoveryListHash ? <FormattedMessage id="did.detail.recovery.set" /> : <FormattedMessage id="did.detail.recovery.none" />}
            </dd>
            <dt><FormattedMessage id="did.detail.verifications" /></dt>
            <dd data-testid="did-verifications">{did.numVerificationsRequired}</dd>
          </dl>

          {isFull ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-transfer-open" onClick={() => setPhase('form')}>
                <FormattedMessage id="did.transfer.button" />
              </button>
              <button type="button" className="dig-btn dig-btn--block" data-testid="did-profile-open" onClick={() => setPhase('profileForm')}>
                <FormattedMessage id="did.profile.button" />
              </button>
            </div>
          ) : (
            <button type="button" className="dig-link" data-testid="did-transfer-fullscreen" onClick={() => void popOutToFullpage('#wallet/did', true)}>
              <FormattedMessage id="did.transfer.openFullscreen" />
            </button>
          )}
        </>
      )}

      {phase === 'form' && (
        <form
          data-testid="did-transfer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <h3 className="dig-heading"><FormattedMessage id="did.transfer.title" /></h3>
          <label className="dig-field">
            <span><FormattedMessage id="did.transfer.recipient" /></span>
            <input data-testid="did-transfer-recipient" className="dig-input dig-mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" />
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="did.transfer.fee" /></span>
            <input data-testid="did-transfer-fee" className="dig-input" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
          </label>
          {localError && <p className="dig-error-text" role="alert" data-testid="did-transfer-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-transfer-review" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : 'did.transfer.review'} />
          </button>
          <button type="button" className="dig-link" data-testid="did-transfer-cancel" onClick={() => setPhase('detail')}>
            <FormattedMessage id="did.transfer.cancel" />
          </button>
        </form>
      )}

      {phase === 'review' && (
        <div data-testid="did-transfer-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="did.transfer.review.intro" /></p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="did.transfer.review.did" /></dt>
            <dd className="dig-mono">{shortenAddress(did.launcherId, 10, 8)}</dd>
            <dt><FormattedMessage id="did.transfer.review.recipient" /></dt>
            <dd className="dig-mono" data-testid="did-review-recipient">{recipient}</dd>
            <dt><FormattedMessage id="did.transfer.review.fee" /></dt>
            <dd data-testid="did-review-fee">{formatBaseUnits(safeFeeMojos(fee), XCH_DECIMALS)} XCH</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-transfer-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="did.transfer.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="did-transfer-back" onClick={() => setPhase('form')}>
            <FormattedMessage id="did.transfer.back" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="did-transfer-sending">
          <FormattedMessage id="did.transfer.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="did-transfer-confirmed">
          <p><FormattedMessage id="did.transfer.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-transfer-done" onClick={onBack}>
            <FormattedMessage id="did.transfer.done" />
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="did-transfer-failed">
          <p><FormattedMessage id="did.transfer.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-transfer-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}

      {phase === 'profileForm' && (
        <form
          data-testid="did-profile-form"
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepareProfile();
          }}
        >
          <h3 className="dig-heading"><FormattedMessage id="did.profile.title" /></h3>
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="did.profile.intro" /></p>
          <label className="dig-field">
            <span><FormattedMessage id="did.profile.name" /></span>
            <input
              data-testid="did-profile-name-input"
              className="dig-input"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              maxLength={PROFILE_NAME_MAX}
              autoComplete="off"
            />
          </label>
          {profileError && <p className="dig-error-text" role="alert" data-testid="did-profile-error">{profileError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-profile-review" disabled={profileBusy}>
            <FormattedMessage id={profileBusy ? 'custody.working' : 'did.profile.review'} />
          </button>
          <button type="button" className="dig-link" data-testid="did-profile-cancel" onClick={() => setPhase('detail')}>
            <FormattedMessage id="did.profile.cancel" />
          </button>
        </form>
      )}

      {phase === 'profileReview' && (
        <div data-testid="did-profile-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}><FormattedMessage id="did.profile.review.intro" /></p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="did.profile.review.did" /></dt>
            <dd className="dig-mono">{shortenAddress(did.launcherId, 10, 8)}</dd>
            <dt><FormattedMessage id="did.profile.review.name" /></dt>
            <dd data-testid="did-profile-review-name">{profileName.trim()}</dd>
          </dl>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="did-profile-confirm" onClick={() => void doConfirmProfile()} disabled={profileBusy}>
            <FormattedMessage id="did.profile.confirm" />
          </button>
          <button type="button" className="dig-link" data-testid="did-profile-back" onClick={() => setPhase('profileForm')}>
            <FormattedMessage id="did.profile.back" />
          </button>
        </div>
      )}

      {phase === 'profileSending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="did-profile-sending">
          <FormattedMessage id="did.profile.sending" />
        </div>
      )}
      {phase === 'profileConfirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="did-profile-confirmed">
          <p><FormattedMessage id="did.profile.confirmed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-profile-done" onClick={onBack}>
            <FormattedMessage id="did.profile.done" />
          </button>
        </div>
      )}
      {phase === 'profileFailed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="did-profile-failed">
          <p><FormattedMessage id="did.profile.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="did-profile-retry" onClick={() => setPhase('profileForm')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
    </section>
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
