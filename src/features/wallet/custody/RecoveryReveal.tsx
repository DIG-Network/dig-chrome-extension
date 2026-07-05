import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';

/**
 * Accessible recovery-phrase reveal (§5.6). Shows the 24 words behind a tap-to-reveal so a
 * shoulder-surfer can't read them on open, then renders a screen-reader-navigable ordered list
 * (NOT handwriting-only theatre — that regresses WCAG). An explicit Copy action writes to the
 * clipboard and AUTO-CLEARS it after a short delay; the on-screen phrase auto-hides too. Warnings
 * are firm and localized. The phrase is passed in (from the create flow) and never persisted.
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
          <ol
            data-testid="recovery-words"
            aria-label="Your 24-word recovery phrase"
            style={{ columns: 2, gap: 12, margin: '12px 0', paddingInlineStart: 24 }}
          >
            {words.map((w, i) => (
              <li key={i} style={{ fontFamily: 'var(--dig-mono, monospace)', padding: '2px 0' }}>
                {w}
              </li>
            ))}
          </ol>
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
