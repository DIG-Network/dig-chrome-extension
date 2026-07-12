import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setTheme } from '@/features/ui/uiSlice';
import { updateWalletSettings } from '@/features/wallet/custody/settings';
import { resolveEffectiveTheme, nextTheme } from '@/lib/theme';
import { useStorageValue } from '@/lib/useStorageValue';
import { hasRuntime } from '@/lib/messaging';
import { ACTIONS } from '@/lib/messages';
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  TOOLBAR_TOGGLE_COMMAND,
  resolveUrnBarSubmit,
  toolbarLabels,
  toolbarBadges,
  toolbarShortcutHint,
  TOOLBAR_PALETTES,
} from '@/lib/toolbar';
import type { ServeVerdict } from '@/lib/dig-serve-headers';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Resolve the ACTUAL bound show/hide shortcut (#366). An extension page CAN call
 *  `chrome.commands.getAll()` directly (unlike a content script, which asks the SW); we return
 *  `null` until resolved so `toolbarShortcutHint` shows the manifest default in the meantime. */
function useToolbarShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    try {
      if (hasRuntime() && chrome.commands?.getAll) {
        chrome.commands.getAll((cmds) => {
          if (chrome.runtime.lastError) return;
          const cmd = Array.isArray(cmds) ? cmds.find((c) => c && c.name === TOOLBAR_TOGGLE_COMMAND) : undefined;
          setShortcut((cmd && cmd.shortcut) || '');
        });
      }
    } catch {
      /* chrome.commands unavailable — keep the default */
    }
  }, []);
  return shortcut;
}

/** Track the browser's `prefers-color-scheme: dark` signal, live (#306 item 2). */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(DARK_QUERY);
    const on = () => setDark(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Fire-and-forget a background message (SW may be asleep — errors are swallowed). */
function send(msg: Record<string, unknown>): void {
  try {
    if (hasRuntime()) chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    /* SW gone / context invalidated */
  }
}

/** Monochrome line-icons for the theme toggle (currentColor-tinted so they inherit the palette). The
 *  icon shows the theme you'd switch TO: a sun while dark (→ light), a moon while light (→ dark). */
function SunGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}
function MoonGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/**
 * The BUILT-IN URN toolbar in the fullscreen extension app shell (#306 item 1). The extension cannot
 * inject a content-script toolbar into its OWN pages, so the fullscreen surface carries the SAME URN
 * bar + verified/local badges as a NATIVE React component — sharing the ONE toolbar core
 * (`@/lib/toolbar`: `resolveUrnBarSubmit`, `toolbarLabels`, `toolbarBadges`, the theme palette) with
 * the injected `dig-toolbar.ts` mount, so the two never diverge. Gated by the SAME `toolbar.enabled`
 * setting the header switch flips; theme-matched to the browser via `prefers-color-scheme`.
 *
 * Enter routes through the shared entry classifier: a `urn` form → the background `navigateToDigUrl`
 * action (the §5.4 node-or-sandbox nav #289/#291 use); an `*.on.dig.net` / `<name>.dig` shorthand →
 * `navigateDigInput` (the SW resolves HEAD→URN #308 from the extension origin). Non-DIG input shows
 * an inline `role="alert"` error rather than navigating.
 */
export function DigToolbar({ verdict = null }: { verdict?: ServeVerdict | null }) {
  const [enabled] = useStorageValue<boolean>(TOOLBAR_ENABLED_KEY, TOOLBAR_ENABLED_DEFAULT);
  const intl = useIntl();
  const dispatch = useAppDispatch();
  // #429 — the bar paints from the PERSISTED theme pref (#111), resolving `system` against the live
  // OS signal, so the URN-bar theme toggle repaints it instantly and it agrees with the ext pages
  // (`useAppliedTheme`/theme.css read the same `ui.theme`). The injected content-script bar has no
  // store and keeps following `prefers-color-scheme` directly (see dig-toolbar.ts).
  const themeMode = useAppSelector((s) => s.ui.theme);
  const prefersDark = usePrefersDark();
  const effective = resolveEffectiveTheme(themeMode, prefersDark);
  const labels = useMemo(
    () => toolbarLabels(typeof navigator !== 'undefined' ? navigator.languages : undefined),
    [],
  );
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const shortcut = useToolbarShortcut();

  if (!enabled) return null;

  const palette = TOOLBAR_PALETTES[effective];
  const badges = toolbarBadges(verdict);
  const isDark = effective === 'dark';

  /** One-tap light↔dark: commit the opposite EXPLICIT mode to the store (instant repaint) + persist
   *  it via the SAME read-modify-write `AppFooter`/locale use, so it survives reload and syncs to
   *  every open surface through `storageSync`. */
  const onToggleTheme = () => {
    const next = nextTheme(effective);
    dispatch(setTheme(next));
    void updateWalletSettings({ theme: next });
  };

  const themeBtnStyle: CSSProperties = {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    border: 0,
    borderRadius: 6,
    cursor: 'pointer',
    background: 'transparent',
    color: palette.btn,
    // Consumed by theme.css for the :hover fill + :focus-visible ring (inline styles can't do either).
    ['--tb-btn-hover' as string]: palette.btnHover,
    ['--tb-focus' as string]: palette.focus,
  };

  const submit = () => {
    const r = resolveUrnBarSubmit(value);
    if (r.ok && r.kind === 'urn') {
      setInvalid(false);
      send({ action: ACTIONS.navigateToDigUrl, url: r.url });
    } else if (r.ok && r.kind === 'on-dig-net') {
      setInvalid(false);
      // #308 — canonicalize the visible URN bar to `chia://<sub>.on.dig.net` (covers the bare
      // `<sub>.on.dig.net`, the `<sub>.dig` shorthand, and the already-canonical form). This keeps
      // the bar showing the DIG address the user opened — NEVER the local node `/s/` URL the tab
      // actually loads from (the SW navigates the tab to the node surface separately, #289).
      setValue(`chia://${r.host}`);
      send({ action: ACTIONS.navigateDigInput, input: r.host });
    } else if (value.trim()) {
      setInvalid(true);
    }
  };

  const barStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: palette.bar,
    borderBottom: `1px solid ${palette.border}`,
    color: palette.text,
  };
  const inputStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    height: 28,
    padding: '0 12px',
    fontSize: 13,
    color: palette.inputText,
    background: palette.inputBg,
    border: `1px solid ${invalid ? palette.warnText : palette.inputBorder}`,
    borderRadius: 14,
    outline: 'none',
  };

  return (
    <div className="dig-builtin-toolbar" role="toolbar" aria-label={labels.toolbar} data-testid="builtin-dig-toolbar" data-theme={effective} style={barStyle}>
      <span aria-hidden="true" style={{ color: palette.mark, fontSize: 13 }}>
        ◈
      </span>
      <input
        type="text"
        value={value}
        placeholder={labels.urnPlaceholder}
        aria-label={labels.urnLabel}
        aria-invalid={invalid || undefined}
        data-testid="builtin-dig-toolbar-urn-input"
        autoComplete="off"
        spellCheck={false}
        style={inputStyle}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <span
        aria-hidden="true"
        data-testid="builtin-dig-toolbar-shortcut-hint"
        style={{ flex: '0 0 auto', fontSize: 11, color: palette.placeholder, whiteSpace: 'nowrap', userSelect: 'none' }}
      >
        {toolbarShortcutHint(labels, shortcut)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {badges.verified.show && (
          <span
            data-testid="builtin-dig-toolbar-badge-verified"
            data-ok={badges.verified.ok ? 'true' : 'false'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 22,
              padding: '0 9px',
              borderRadius: 11,
              fontSize: 11.5,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              background: badges.verified.ok ? palette.okBg : palette.warnBg,
              color: badges.verified.ok ? palette.okText : palette.warnText,
            }}
          >
            {(badges.verified.ok ? '✓ ' : '⚠ ') + labels.verified}
          </span>
        )}
        {badges.local.show && (
          <span
            data-testid="builtin-dig-toolbar-badge-local"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 22,
              padding: '0 9px',
              borderRadius: 11,
              fontSize: 11.5,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              background: palette.badgeBg,
              color: palette.badgeText,
            }}
          >
            {'⬇ ' + labels.local}
          </span>
        )}
      </span>
      <button
        type="button"
        className="dig-builtin-toolbar__theme-btn"
        data-testid="builtin-dig-toolbar-theme-toggle"
        aria-pressed={isDark}
        aria-label={intl.formatMessage({ id: 'toolbar.theme.toggle' })}
        title={intl.formatMessage({ id: 'toolbar.theme.toggle' })}
        onClick={onToggleTheme}
        style={themeBtnStyle}
      >
        {isDark ? <SunGlyph /> : <MoonGlyph />}
      </button>
      <span role="alert" data-testid="builtin-dig-toolbar-urn-error" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        {invalid ? labels.urnInvalid : ''}
      </span>
    </div>
  );
}
