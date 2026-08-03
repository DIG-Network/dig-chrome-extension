import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { copyText } from '@/lib/clipboard';

/** Monochrome clipboard glyph (currentColor-tinted so it inherits the chip's text color). */
function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * A runnable shell command rendered as a click-to-copy chip (#500) — removes the friction of
 * hand-retyping a long pairing id / CLI invocation. Click anywhere on the chip (or focus + Enter/
 * Space) copies the FULL `command` via the shared {@link copyText} helper and flips to a transient
 * "Copied!" state (~1.5s, matching the idiom in {@link XchtipButtonSection}'s `CopyButton`) before
 * reverting.
 *
 * A pure presentational primitive (§6.4 layering): no store access, no feature imports — it owns
 * only its own copy/feedback state and takes the command string as a prop.
 */
export function CopyableCommand({ command, label, testid }: { command: string; label?: string; testid?: string }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void copyText(command).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const ariaLabel = label ?? intl.formatMessage({ id: 'command.copy.ariaLabel' });

  return (
    <button
      type="button"
      className="dig-command-chip"
      data-testid={testid}
      data-copied={copied ? 'true' : 'false'}
      aria-label={ariaLabel}
      onClick={onCopy}
    >
      <code className="dig-command-chip-text">{command}</code>
      <span className="dig-command-chip-icon" aria-hidden="true">
        <CopyGlyph />
      </span>
      {copied && (
        <span className="dig-command-chip-feedback" role="status">
          <FormattedMessage id="command.copy.copied" />
        </span>
      )}
    </button>
  );
}
