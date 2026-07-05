import { useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useCreateWalletMutation, useImportWalletMutation } from '@/features/wallet/custodyApi';
import { RecoveryReveal } from '@/features/wallet/custody/RecoveryReveal';

type Step = 'welcome' | 'create' | 'reveal' | 'confirm' | 'import';

/**
 * Self-custody onboarding (§6, Fable: lives in fullscreen). Welcome → Create (set password →
 * back up the recovery phrase behind the accessible reveal → confirm one word) OR Import (paste the
 * phrase + set a password). On success the wallet is created/unlocked in the offscreen vault and
 * `onDone` lets the gate proceed. A secondary path keeps the Sage-broker connect available.
 */
export function Onboarding({ onDone, onUseSage }: { onDone: () => void; onUseSage?: () => void }) {
  const intl = useIntl();
  const [step, setStep] = useState<Step>('welcome');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [strong, setStrong] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [importPhrase, setImportPhrase] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const [createWallet, createState] = useCreateWalletMutation();
  const [importWallet, importState] = useImportWalletMutation();

  // A random word index to confirm the user backed up the phrase.
  const confirmIndex = useMemo(() => (mnemonic ? Math.floor(Math.random() * 24) : 0), [mnemonic]);
  const busy = createState.isLoading || importState.isLoading;

  function pwError(): string | null {
    if (password.length < 8) return intl.formatMessage({ id: 'custody.error.pwShort' });
    if (password !== confirmPw) return intl.formatMessage({ id: 'custody.error.pwMismatch' });
    return null;
  }

  async function doCreate() {
    const err = pwError();
    if (err) { setLocalError(err); return; }
    setLocalError(null);
    const res = await createWallet({ password, strong });
    if ('data' in res && res.data?.mnemonic) {
      setMnemonic(res.data.mnemonic);
      setStep('reveal');
    } else {
      setLocalError(intl.formatMessage({ id: 'custody.error.createFailed' }));
    }
  }

  async function doImport() {
    const err = pwError();
    if (err) { setLocalError(err); return; }
    setLocalError(null);
    const res = await importWallet({ mnemonic: importPhrase, password });
    if ('data' in res && res.data) {
      onDone();
    } else {
      setLocalError(intl.formatMessage({ id: 'custody.error.invalidPhrase' }));
    }
  }

  function verifyConfirmWord() {
    const expected = mnemonic.trim().split(/\s+/)[confirmIndex];
    if (confirmWord.trim().toLowerCase() === expected) onDone();
    else setLocalError(intl.formatMessage({ id: 'custody.error.wrongWord' }));
  }

  return (
    <section data-testid="custody-onboarding" aria-labelledby="onboarding-title">
      <h1 className="dig-heading" id="onboarding-title">
        <FormattedMessage id="custody.onboarding.title" />
      </h1>

      {step === 'welcome' && (
        <div className="dig-card" data-testid="onboarding-welcome">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="custody.onboarding.intro" />
          </p>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="onboarding-create" onClick={() => setStep('create')}>
            <FormattedMessage id="custody.onboarding.create" />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="onboarding-import" onClick={() => setStep('import')}>
            <FormattedMessage id="custody.onboarding.import" />
          </button>
          {onUseSage && (
            <button type="button" className="dig-link" data-testid="onboarding-sage" onClick={onUseSage}>
              <FormattedMessage id="custody.onboarding.useSage" />
            </button>
          )}
        </div>
      )}

      {(step === 'create' || step === 'import') && (
        <form
          className="dig-card"
          data-testid={step === 'create' ? 'onboarding-create-form' : 'onboarding-import-form'}
          onSubmit={(e) => {
            e.preventDefault();
            void (step === 'create' ? doCreate() : doImport());
          }}
        >
          {step === 'import' && (
            <label className="dig-field">
              <span><FormattedMessage id="custody.import.phrase" /></span>
              <textarea
                data-testid="import-phrase"
                className="dig-input"
                rows={3}
                value={importPhrase}
                onChange={(e) => setImportPhrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <label className="dig-field">
            <span><FormattedMessage id="custody.password" /></span>
            <input data-testid="onboarding-password" className="dig-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="custody.passwordConfirm" /></span>
            <input data-testid="onboarding-password-confirm" className="dig-input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </label>
          {step === 'create' && (
            <label className="dig-check">
              <input type="checkbox" data-testid="onboarding-strong" checked={strong} onChange={(e) => setStrong(e.target.checked)} />
              <span><FormattedMessage id="custody.strongPreset" /></span>
            </label>
          )}
          {localError && <p className="dig-error-text" role="alert" data-testid="onboarding-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="onboarding-submit" disabled={busy}>
            <FormattedMessage id={busy ? 'custody.working' : step === 'create' ? 'custody.onboarding.createSubmit' : 'custody.onboarding.importSubmit'} />
          </button>
        </form>
      )}

      {step === 'reveal' && (
        <>
          <RecoveryReveal mnemonic={mnemonic} />
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="reveal-continue" onClick={() => { setLocalError(null); setStep('confirm'); }}>
            <FormattedMessage id="custody.reveal.continue" />
          </button>
        </>
      )}

      {step === 'confirm' && (
        <form
          className="dig-card"
          data-testid="onboarding-confirm-form"
          onSubmit={(e) => { e.preventDefault(); verifyConfirmWord(); }}
        >
          <label className="dig-field">
            <span><FormattedMessage id="custody.confirm.prompt" values={{ n: confirmIndex + 1 }} /></span>
            <input data-testid="confirm-word" className="dig-input" value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} autoComplete="off" />
          </label>
          {localError && <p className="dig-error-text" role="alert" data-testid="confirm-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="confirm-submit">
            <FormattedMessage id="custody.confirm.submit" />
          </button>
        </form>
      )}
    </section>
  );
}
