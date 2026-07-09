import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { SecretPhrase } from '@/features/wallet/custody/SecretPhrase';
import { useExportPrivateKeyMutation } from '@/features/wallet/custodyApi';

/**
 * Private-key export (#96, §18.20) — an ADVANCED, fullscreen-only reveal of the raw (pre-synthetic)
 * account secret key at the wallet's ACTIVE derivation index, for BOTH HD schemes. Security-sensitive
 * (§5.6): gated behind an explicit password re-auth (the SW re-runs the full Argon2 decrypt, never the
 * cached unlock window), with firm warnings. The revealed hex renders inside the SAME closed-shadow-
 * root {@link SecretPhrase} primitive the recovery-phrase reveal uses — un-scrapeable from the light
 * DOM by another extension or an injected page script — with an explicit Copy that auto-clears the
 * clipboard. The key material is never persisted and is dropped from component state on unmount.
 */
export function ExportPrivateKey({ clipboardClearMs = 30_000 }: { clipboardClearMs?: number }) {
  const intl = useIntl();
  const [exportPrivateKey, exportState] = useExportPrivateKeyMutation();
  const [password, setPassword] = useState('');
  const [keys, setKeys] = useState<{ scheme: 'unhardened' | 'hardened'; hex: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drop any revealed key material when this panel unmounts.
  useEffect(() => () => setKeys(null), []);

  async function doReveal() {
    setError(null);
    const res = await exportPrivateKey({ password });
    if ('data' in res && res.data?.privateKeys) {
      setKeys(res.data.privateKeys);
      setPassword('');
    } else {
      setError(intl.formatMessage({ id: 'export.error' }));
    }
  }

  return (
    <section className="dig-card" data-testid="export-private-key" aria-labelledby="export-pk-title">
      <h2 className="dig-heading" id="export-pk-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="export.title" />
      </h2>
      <p className="dig-error-text" role="note" style={{ marginTop: 0 }}>
        <FormattedMessage id="export.warn" />
      </p>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="export.warn.never" />
      </p>

      {keys ? (
        <div data-testid="export-pk-result">
          {keys.map((k) => (
            <PrivateKeyReveal key={k.scheme} scheme={k.scheme} hex={k.hex} clipboardClearMs={clipboardClearMs} />
          ))}
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); if (password) void doReveal(); }}
          data-testid="export-pk-form"
        >
          <label className="dig-field">
            <span><FormattedMessage id="export.password" /></span>
            <input
              className="dig-input"
              type="password"
              data-testid="export-pk-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <p className="dig-error-text" role="alert" data-testid="export-pk-error">{error}</p>}
          <button
            type="submit"
            className="dig-btn dig-btn--danger dig-btn--block"
            data-testid="export-pk-reveal"
            disabled={!password || exportState.isLoading}
          >
            <FormattedMessage id={exportState.isLoading ? 'custody.working' : 'export.reveal'} />
          </button>
        </form>
      )}
    </section>
  );
}

/** One scheme's revealed private key: a labelled, closed-shadow-root reveal + a clipboard-clearing copy. */
function PrivateKeyReveal({
  scheme,
  hex,
  clipboardClearMs,
}: {
  scheme: 'unhardened' | 'hardened';
  hex: string;
  clipboardClearMs: number;
}) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const clipTimer = useRef<ReturnType<typeof setTimeout>>();
  const labelId = scheme === 'hardened' ? 'export.scheme.hardened' : 'export.scheme.unhardened';

  useEffect(() => () => clearTimeout(clipTimer.current), []);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(hex);
      setCopied(true);
      clearTimeout(clipTimer.current);
      clipTimer.current = setTimeout(() => {
        void navigator.clipboard?.writeText('').catch(() => {});
        setCopied(false);
      }, clipboardClearMs);
    } catch {
      /* clipboard unavailable — the on-screen reveal is the fallback */
    }
  }

  return (
    <div data-testid={`export-pk-${scheme}`} style={{ marginTop: 10 }}>
      <h3 className="dig-muted" style={{ margin: '0 0 4px', fontSize: '0.85em', textTransform: 'uppercase' }}>
        <FormattedMessage id={labelId} />
      </h3>
      <SecretPhrase words={[hex]} ariaLabel={intl.formatMessage({ id: labelId })} testid={`export-pk-words-${scheme}`} />
      <button type="button" className="dig-btn dig-btn--block" data-testid={`export-pk-copy-${scheme}`} onClick={() => void copy()}>
        <FormattedMessage id={copied ? 'export.copied' : 'export.copy'} />
      </button>
      {copied && (
        <p className="dig-muted" role="status" style={{ marginBottom: 0 }}>
          <FormattedMessage id="export.clipboardNote" />
        </p>
      )}
    </div>
  );
}
