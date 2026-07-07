import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { parseOpenUrnInput, resolveOpenTarget } from '@/lib/open-urn';
import { useGetDigDnsStatusQuery } from '@/features/resolver/resolverApi';
import { ACTIONS } from '@/lib/messages';
import { hasRuntime, sendAction } from '@/lib/messaging';

/**
 * Navigate the active browser tab to `url` (a real http(s) address), then best-effort close this
 * popup so the user sees the result. Mirrors the Resolver tab's own `openUrl` — `window.close()`
 * silently no-ops outside a popup context (e.g. the fullscreen tab), which is fine.
 */
function openInActiveTab(url: string): void {
  if (!hasRuntime() || !chrome.tabs) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    void chrome.tabs.update(id, { url });
    try {
      window.close();
    } catch {
      /* not closable (e.g. the fullscreen tab) — ignore */
    }
  });
}

/**
 * #172 — the home-screen "open a chia:// address or DIG URN" input. Validates the typed address
 * against the single shared URN grammar (`parseURN`, src/lib/dig-urn.ts) client-side (shape only,
 * no fetch); on a valid address it reads the shared dig-dns availability signal
 * (`getDigDnsStatus`, NEVER re-probed here) to pick where it opens (src/lib/open-urn.ts):
 *
 *   - dig-dns reachable (`direct`/`proxy`) -> the native `.dig`-scheme URL, in the active tab.
 *   - dig-dns unreachable (or no signal yet) -> the extension's own chrome-extension:// content
 *     view, via the background `navigateToDigUrl` action (redirects the active tab to
 *     dig-viewer.html — the existing §5.3 node-ladder read + branded loader, verified + decrypted).
 *
 * An invalid, non-empty address shows an inline, translated error instead of navigating; an empty
 * submit is a silent no-op (nothing was typed yet).
 */
export function OpenByUrnInput() {
  const intl = useIntl();
  const digDnsStatus = useGetDigDnsStatusQuery();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const onChange = (next: string) => {
    setValue(next);
    if (invalid) setInvalid(false);
  };

  const submit = () => {
    const parsed = parseOpenUrnInput(value);
    if (!parsed) {
      if (value.trim()) setInvalid(true);
      return;
    }
    setInvalid(false);
    const target = resolveOpenTarget(parsed, digDnsStatus.data?.phase);
    if (target.kind === 'dig-scheme') {
      openInActiveTab(target.url);
    } else {
      void sendAction({ action: ACTIONS.navigateToDigUrl, url: target.url }).catch(() => {});
      try {
        window.close();
      } catch {
        /* not closable — ignore */
      }
    }
  };

  return (
    <div className="dig-widget dig-openurn" data-testid="home-openurn">
      <label htmlFor="home-openurn-input" className="dig-widget-label">
        <FormattedMessage id="home.open.label" />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input
          id="home-openurn-input"
          className="dig-input dig-mono"
          data-testid="home-openurn-input"
          placeholder={intl.formatMessage({ id: 'home.open.placeholder' })}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'home-openurn-error' : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="dig-btn dig-btn--primary" data-testid="home-openurn-go" onClick={submit}>
          <FormattedMessage id="home.open.go" />
        </button>
      </div>
      {invalid && (
        <p className="dig-error-text" role="alert" id="home-openurn-error" data-testid="home-openurn-error">
          <FormattedMessage id="home.open.error.invalid" />
        </p>
      )}
    </div>
  );
}
