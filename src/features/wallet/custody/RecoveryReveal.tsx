import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { SecretPhrase } from '@/features/wallet/custody/SecretPhrase';

/**
 * Accessible recovery-phrase reveal (§5.6). Shows the 24 words behind a tap-to-reveal so a
 * shoulder-surfer can't read them on open, then renders a screen-reader-navigable ordered list
 * (NOT handwriting-only theatre — that regresses WCAG) inside a CLOSED shadow root
 * ({@link SecretPhrase}, #67 P1-5) so the words can't be DOM-scraped by another extension or an
 * injected page script. An explicit Copy action writes to the clipboard and AUTO-CLEARS it after a
 * short delay; the on-screen phrase auto-hides too. Warnings are firm and localized. The phrase is
 * passed in (from the create flow) and never persisted.
 */
export function RecoveryReveal({
  mnemonic,
  autoHideMs = 60_000,
  clipboardClearMs = 30_000,
}: {
  mnemonic: string;
  autoHideMs?: number;
  clipboardClearMs?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const clipTimer = useRef<ReturnType<typeof setTimeout>>();
  const words = mnemonic.trim().split(/\s+/);

  useEffect(() => () => {
    clearTimeout(hideTimer.current);
    clearTimeout(clipTimer.current);
  }, []);

  function reveal() {
    setRevealed(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setRevealed(false), autoHideMs);
  }

  async function copy() {
    try {
      await navigator.clipboard?.writeText(mnemonic);
      setCopied(true);
      clearTimeout(clipTimer.current);
      clipTimer.current = setTimeout(() => {
        void navigator.clipboard?.writeText('').catch(() => {});
        setCopied(false);
      }, clipboardClearMs);
    } catch {
      /* clipboard unavailable — the on-screen list is the fallback */
    }
  }

  return (
    <section className="dig-card" data-testid="recovery-reveal" aria-labelledby="recovery-title">
      <h2 className="dig-heading" id="recovery-title">
        <FormattedMessage id="custody.recovery.title" />
      </h2>
      <p className="dig-error-text" role="note" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.recovery.warn.control" />
      </p>
      <ul className="dig-muted" style={{ marginTop: 0 }}>
        <li><FormattedMessage id="custody.recovery.warn.never" /></li>
        <li><FormattedMessage id="custody.recovery.warn.paste" /></li>
      </ul>

      {!revealed ? (
        <button
          type="button"
          className="dig-btn dig-btn--block"
          data-testid="recovery-reveal-btn"
          onClick={reveal}
        >
          <FormattedMessage id="custody.recovery.reveal" />
        </button>
      ) : (
        <>
          <SecretPhrase words={words} ariaLabel="Your 24-word recovery phrase" />
          <button type="button" className="dig-btn dig-btn--block" data-testid="recovery-copy" onClick={() => void copy()}>
            <FormattedMessage id={copied ? 'custody.recovery.copied' : 'custody.recovery.copy'} />
          </button>
          {copied && (
            <p className="dig-muted" role="status" style={{ marginBottom: 0 }}>
              <FormattedMessage id="custody.recovery.clipboardNote" />
            </p>
          )}
        </>
      )}
    </section>
  );
}
