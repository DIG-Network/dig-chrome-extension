import { useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  useCreateWalletMutation,
  useImportWalletMutation,
  useImportWatchWalletMutation,
  useImportWalletBackupMutation,
} from '@/features/wallet/custodyApi';
import { RecoveryReveal } from '@/features/wallet/custody/RecoveryReveal';

type Step = 'welcome' | 'security' | 'create' | 'reveal' | 'confirm' | 'backupReminder' | 'import' | 'watch' | 'restore';

/**
 * Self-custody onboarding (§6, Fable: lives in fullscreen). Welcome → [security nudge] → Create
 * (set password → back up the recovery phrase behind the accessible reveal → confirm one word →
 * backup reminder) OR Import (paste the phrase + set a password). On success the wallet is
 * created/unlocked in the offscreen vault and `onDone` lets the gate proceed.
 *
 * Two security nudges bracket the phrase-handling paths (#79 P2-3, the "right moments" — not a
 * blanket checkbox nobody reads):
 *   - BEFORE Create/Import — a phishing-education step (a scam site asking for the phrase; DIG
 *     never asks for it) the user must explicitly acknowledge with Continue before reaching either
 *     form. Skipped for Watch-only (#96, a public key only — no phrase exists to protect) and
 *     Restore (#115, an existing ENCRYPTED backup file, not a raw phrase typed in).
 *   - AFTER a NEW phrase is confirmed (create only) — a backup reminder pointing at the encrypted
 *     backup-file export (#115, reachable from the wallet switcher) as a second recovery method,
 *     right when the user has just proven they wrote the phrase down. Import skips this: importing
 *     an existing phrase means the user already has their own backup by definition.
 * The existing `custody.strongPreset` (256 MiB Argon2id toggle) on the create form and
 * `custody.recovery.warn.never` ("DIG will never ask for your recovery phrase") in the reveal step
 * are the OTHER two nudges the parent roadmap calls for — both already shipped; this component adds
 * only the two above.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const intl = useIntl();
  const [step, setStep] = useState<Step>('welcome');
  // Where Continue on the security nudge goes — set when Create/Import is chosen from Welcome.
  const [afterSecurity, setAfterSecurity] = useState<'create' | 'import'>('create');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [strong, setStrong] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [importPhrase, setImportPhrase] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [watchKey, setWatchKey] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Create/Import from Welcome route through the phishing-education nudge first (#79). */
  function startPhraseFlow(target: 'create' | 'import') {
    setAfterSecurity(target);
    setLocalError(null);
    setStep('security');
  }

  const [createWallet, createState] = useCreateWalletMutation();
  const [importWallet, importState] = useImportWalletMutation();
  const [importWatchWallet, watchState] = useImportWatchWalletMutation();
  const [importWalletBackup, restoreState] = useImportWalletBackupMutation();

  // A random word index to confirm the user backed up the phrase.
  const confirmIndex = useMemo(() => (mnemonic ? Math.floor(Math.random() * 24) : 0), [mnemonic]);
  const busy = createState.isLoading || importState.isLoading || watchState.isLoading || restoreState.isLoading;

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
    // #79 — a NEW wallet's phrase is confirmed: nudge a SECOND backup method (the encrypted backup
    // file) before finishing, rather than finishing silently. Import never reaches this step (it
    // has its own onDone path in doImport) — an imported phrase is already backed up by definition.
    if (confirmWord.trim().toLowerCase() === expected) setStep('backupReminder');
    else setLocalError(intl.formatMessage({ id: 'custody.error.wrongWord' }));
  }

  // #96 — add a spend-less watch-only wallet from a public key only (no password).
  async function doWatch() {
    setLocalError(null);
    const res = await importWatchWallet({ publicKeyHex: watchKey.trim() });
    if ('data' in res && res.data) onDone();
    else setLocalError(intl.formatMessage({ id: 'watch.error.invalid' }));
  }

  // #115 — restore a wallet from a chosen backup file; it lands LOCKED (unlock screen prompts next).
  async function doRestore(file: File) {
    setLocalError(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setLocalError(intl.formatMessage({ id: 'backup.error.badFile' }));
      return;
    }
    const res = await importWalletBackup({ json: text });
    if ('data' in res && res.data) {
      onDone();
      return;
    }
    const code = (res as { error?: { code?: string } }).error?.code;
    setLocalError(intl.formatMessage({ id: code === 'ALREADY_EXISTS' ? 'backup.error.exists' : 'backup.error.badFile' }));
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
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="onboarding-create" onClick={() => startPhraseFlow('create')}>
            <FormattedMessage id="custody.onboarding.create" />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="onboarding-import" onClick={() => startPhraseFlow('import')}>
            <FormattedMessage id="custody.onboarding.import" />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="onboarding-restore" onClick={() => { setLocalError(null); setStep('restore'); }}>
            <FormattedMessage id="custody.onboarding.restore" />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="onboarding-watch" onClick={() => { setLocalError(null); setStep('watch'); }}>
            <FormattedMessage id="custody.onboarding.watch" />
          </button>
        </div>
      )}

      {step === 'security' && (
        <div className="dig-card" data-testid="onboarding-security" aria-labelledby="onboarding-security-title">
          <h2 className="dig-section-title" id="onboarding-security-title" style={{ marginTop: 0 }}>
            <FormattedMessage id="custody.onboarding.security.title" />
          </h2>
          <ul className="dig-muted" style={{ marginTop: 0 }}>
            <li><FormattedMessage id="custody.onboarding.security.neverAsk" /></li>
            <li><FormattedMessage id="custody.onboarding.security.phishing" /></li>
            <li><FormattedMessage id="custody.onboarding.security.neverShare" /></li>
          </ul>
          <button
            type="button"
            className="dig-btn dig-btn--primary dig-btn--block"
            data-testid="onboarding-security-continue"
            onClick={() => setStep(afterSecurity)}
          >
            <FormattedMessage id="custody.onboarding.security.continue" />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="onboarding-security-cancel" onClick={() => setStep('welcome')}>
            <FormattedMessage id="account.cancel" />
          </button>
        </div>
      )}

      {step === 'watch' && (
        <form
          className="dig-card"
          data-testid="onboarding-watch-form"
          onSubmit={(e) => { e.preventDefault(); if (watchKey.trim()) void doWatch(); }}
        >
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="watch.intro" />
          </p>
          <label className="dig-field">
            <span><FormattedMessage id="watch.publicKey" /></span>
            <textarea
              data-testid="watch-public-key"
              className="dig-input"
              rows={2}
              value={watchKey}
              onChange={(e) => setWatchKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {localError && <p className="dig-error-text" role="alert" data-testid="watch-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="watch-submit" disabled={busy || !watchKey.trim()}>
            <FormattedMessage id={busy ? 'custody.working' : 'watch.submit'} />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="watch-cancel" onClick={() => { setLocalError(null); setStep('welcome'); }}>
            <FormattedMessage id="account.cancel" />
          </button>
        </form>
      )}

      {step === 'restore' && (
        <div className="dig-card" data-testid="onboarding-restore-form">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="backup.restore.intro" />
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            data-testid="restore-file"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doRestore(f); }}
          />
          {localError && <p className="dig-error-text" role="alert" data-testid="restore-error">{localError}</p>}
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="restore-choose" disabled={busy} onClick={() => fileRef.current?.click()}>
            <FormattedMessage id={busy ? 'custody.working' : 'backup.restore.choose'} />
          </button>
          <button type="button" className="dig-btn dig-btn--block" data-testid="restore-cancel" onClick={() => { setLocalError(null); setStep('welcome'); }}>
            <FormattedMessage id="account.cancel" />
          </button>
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

      {step === 'backupReminder' && (
        <div className="dig-card" data-testid="onboarding-backup-reminder" aria-labelledby="onboarding-backup-title">
          <h2 className="dig-section-title" id="onboarding-backup-title" style={{ marginTop: 0 }}>
            <FormattedMessage id="custody.onboarding.backup.title" />
          </h2>
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="custody.onboarding.backup.body" />
          </p>
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="onboarding-backup-reminder-finish" onClick={onDone}>
            <FormattedMessage id="custody.onboarding.backup.finish" />
          </button>
        </div>
      )}
    </section>
  );
}
