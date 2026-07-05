import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { EXPLORE_URL } from '#shared/links.mjs';
import { ExternalLink } from '@/components/ExternalLink';

/** The single embed URL for BOTH surfaces — explore's own responsive breakpoint decides the view. */
const APPS_URL = `${EXPLORE_URL}/apps`;

/** How long to wait for the iframe to load before showing the error/retry state (ms). */
const LOAD_TIMEOUT = 12000;

/**
 * The Apps tab (#59) — the curated DIG dApp store (explore.dig.net) embedded in-window via an
 * iframe. The SAME URL is embedded on both surfaces; explore's responsive breakpoint renders the
 * mobile launcher at the popup's narrow width and the full desktop store in the wide `app.html`
 * surface, so the iframe just needs to FILL its container at each width. explore.dig.net sends no
 * frame-ancestors block, so it embeds directly (the extension CSP adds `frame-src
 * https://explore.dig.net`). Four states: loading (until the iframe's `load` fires or a timeout),
 * error + retry (reloads the frame), success. An "open in a new tab" affordance is always present.
 */
export function AppsTab() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const url = APPS_URL;

  useEffect(() => {
    setStatus('loading');
    timer.current = window.setTimeout(() => setStatus((s) => (s === 'loading' ? 'error' : s)), LOAD_TIMEOUT);
    return () => window.clearTimeout(timer.current);
  }, [attempt, url]);

  const onLoad = () => {
    window.clearTimeout(timer.current);
    setStatus('ready');
  };
  const retry = () => {
    setAttempt((n) => n + 1);
  };

  return (
    <section className="dig-appswrap" data-testid="apps-panel" aria-labelledby="apps-title">
      <div className="dig-toggle-row">
        <h2 className="dig-heading" id="apps-title" style={{ margin: 0 }}>
          <FormattedMessage id="apps.title" />
        </h2>
        <ExternalLink href={url} testid="apps-open-tab">
          ↗ <FormattedMessage id="apps.openTab" />
        </ExternalLink>
      </div>

      {status === 'loading' && (
        <div className="dig-state" role="status" aria-live="polite" data-state="loading" data-testid="apps-loading">
          <div className="dig-skeleton" style={{ width: '100%' }} />
          <span className="dig-muted">
            <FormattedMessage id="apps.loading" />
          </span>
        </div>
      )}
      {status === 'error' && (
        <div className="dig-state" role="alert" data-state="error" data-testid="apps-error">
          <p>
            <FormattedMessage id="apps.error" />
          </p>
          <button type="button" className="dig-btn" data-testid="apps-retry" onClick={retry}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}

      {status !== 'error' && (
        <iframe
          key={attempt}
          className="dig-appsframe"
          data-testid="apps-frame"
          title="DIG dApp store"
          src={url}
          onLoad={onLoad}
          style={{ display: status === 'ready' ? 'block' : 'none' }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      )}
    </section>
  );
}
