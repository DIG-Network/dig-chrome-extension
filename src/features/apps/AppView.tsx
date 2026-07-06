import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { closeApp } from '@/features/ui/uiSlice';
import { hasRuntime } from '@/lib/messaging';
import { isFramedDigHost, enableFramingBypass, disableFramingBypass } from '@/features/apps/framingBypass';

/** How long to wait for the dApp frame to load before treating the embed as refused (ms). */
const LOAD_TIMEOUT = 6000;

type Phase = 'loading' | 'ready' | 'blocked';

/** Open a dApp URL in a real browser tab (extension → `chrome.tabs.create`; else a window). */
function openInTab(url: string): void {
  if (hasRuntime() && chrome.tabs?.create) void chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The in-window dApp app-view (#65 §2.4a) — launching a dApp from the launcher opens it INSIDE the
 * extension frame like a phone app: a top bar (back → home, the app name, ⤢ expand to a full tab)
 * over an iframe of the dApp's `link`. Four states: loading (a spinner over the phone frame until the
 * frame's `load` fires or a timeout), ready (the frame), and BLOCKED — a refused embed
 * (X-Frame-Options / CSP `frame-ancestors` / load error / timeout) is detected and the dApp is
 * gracefully opened in a NEW TAB with a one-line note, so the user NEVER sees a blank frame. Rendered
 * as a full-surface overlay on both layouts; `Escape` closes it.
 *
 * DIG's own `*.on.dig.net` dApps serve `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`, so
 * before loading such a link we ask the SW to install an ephemeral framing-bypass DNR rule (#66) and
 * only then set the iframe `src`; the rule is removed when the view closes. Non-DIG dApps keep the
 * iframe-or-tab-fallback behaviour unchanged.
 */
export function AppView() {
  const app = useAppSelector((s) => s.ui.openApp);
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>('loading');
  // Whether the iframe may load yet. For a DIG on.dig.net link we hold it until the framing bypass
  // is installed; for every other link it is ready immediately (no behaviour change).
  const [frameReady, setFrameReady] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fellBack = useRef(false);
  const link = app?.link;
  const needsBypass = isFramedDigHost(link);

  // Reset, install the framing bypass for on.dig.net, then arm the load-timeout. Cleanup removes the
  // bypass so on.dig.net keeps its framing protection against every other embedder.
  useEffect(() => {
    if (!link) return;
    fellBack.current = false;
    setPhase('loading');
    setFrameReady(!needsBypass);
    let cancelled = false;
    let bypassed = false;
    if (needsBypass) {
      void (async () => {
        bypassed = await enableFramingBypass();
        if (cancelled) {
          if (bypassed) void disableFramingBypass();
          return;
        }
        // Load either way: if the bypass failed, the embed is simply refused → the tab fallback.
        setFrameReady(true);
      })();
    }
    timer.current = window.setTimeout(() => setPhase((p) => (p === 'loading' ? 'blocked' : p)), LOAD_TIMEOUT);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      if (bypassed) void disableFramingBypass();
    };
  }, [link, needsBypass]);

  // On BLOCKED, gracefully open the dApp in a new tab exactly once (never leave a blank frame).
  useEffect(() => {
    if (phase === 'blocked' && link && !fellBack.current) {
      fellBack.current = true;
      openInTab(link);
    }
  }, [phase, link]);

  // Escape closes the app-view (a11y — like backing out of a phone app).
  useEffect(() => {
    if (!app) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch(closeApp());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, dispatch]);

  if (!app) return null;

  // A `load` fires for BOTH a successful embed AND a refused one (X-Frame-Options / CSP
  // frame-ancestors make Chromium fire load on a blank/error document). Distinguish them: a real
  // cross-origin dApp throws a SecurityError when we read its `location` (→ ready); a refused frame
  // stays a readable `about:blank` (→ blocked, fall back to a tab).
  const onLoad = () => {
    window.clearTimeout(timer.current);
    try {
      const href = frameRef.current?.contentWindow?.location?.href;
      if (href === 'about:blank' || href === '') {
        setPhase('blocked');
        return;
      }
    } catch {
      /* cross-origin read threw → the frame loaded a real page → ready */
    }
    setPhase((p) => (p === 'blocked' ? p : 'ready'));
  };

  return (
    <div className="dig-appview" role="dialog" aria-modal="true" aria-label={app.name} data-testid="appview">
      <header className="dig-appview-bar">
        <button type="button" className="dig-iconbtn" data-testid="appview-back" aria-label={intl.formatMessage({ id: 'appview.back' })} onClick={() => dispatch(closeApp())}>
          ‹
        </button>
        <span className="dig-appview-title" data-testid="appview-title">{app.name}</span>
        <button
          type="button"
          className="dig-iconbtn"
          data-testid="appview-expand"
          aria-label={intl.formatMessage({ id: 'appview.expand' })}
          title={intl.formatMessage({ id: 'appview.expand' })}
          onClick={() => {
            openInTab(app.link);
            dispatch(closeApp());
          }}
        >
          ⤢
        </button>
      </header>

      <div className="dig-appview-body">
        {phase === 'loading' && (
          <div className="dig-state" role="status" aria-live="polite" data-state="loading" data-testid="appview-loading">
            <div className="dig-skeleton" style={{ width: '100%' }} />
            <span className="dig-muted"><FormattedMessage id="appview.loading" values={{ name: app.name }} /></span>
          </div>
        )}

        {phase === 'blocked' && (
          <div className="dig-state" role="status" data-state="empty" data-testid="appview-blocked">
            <p><FormattedMessage id="appview.blocked" values={{ name: app.name }} /></p>
            <button type="button" className="dig-btn dig-btn--primary" data-testid="appview-open-tab" onClick={() => openInTab(app.link)}>
              <FormattedMessage id="appview.openTab" />
            </button>
          </div>
        )}

        {phase !== 'blocked' && frameReady && (
          <iframe
            ref={frameRef}
            className="dig-appview-frame"
            data-testid="appview-frame"
            title={app.name}
            src={app.link}
            onLoad={onLoad}
            onError={() => setPhase('blocked')}
            style={{ display: phase === 'ready' ? 'block' : 'none' }}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin allow-downloads"
          />
        )}
      </div>
    </div>
  );
}
