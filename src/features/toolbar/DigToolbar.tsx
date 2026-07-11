import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useStorageValue } from '@/lib/useStorageValue';
import { hasRuntime } from '@/lib/messaging';
import { ACTIONS } from '@/lib/messages';
import {
  TOOLBAR_ENABLED_KEY,
  TOOLBAR_ENABLED_DEFAULT,
  resolveUrnBarSubmit,
  toolbarLabels,
  toolbarBadges,
  toolbarTheme,
  TOOLBAR_PALETTES,
} from '@/lib/toolbar';
import type { ServeVerdict } from '@/lib/dig-serve-headers';

const DARK_QUERY = '(prefers-color-scheme: dark)';

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
  const prefersDark = usePrefersDark();
  const labels = useMemo(
    () => toolbarLabels(typeof navigator !== 'undefined' ? navigator.languages : undefined),
    [],
  );
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (!enabled) return null;

  const palette = TOOLBAR_PALETTES[toolbarTheme(prefersDark)];
  const badges = toolbarBadges(verdict);

  const submit = () => {
    const r = resolveUrnBarSubmit(value);
    if (r.ok && r.kind === 'urn') {
      setInvalid(false);
      send({ action: ACTIONS.navigateToDigUrl, url: r.url });
    } else if (r.ok && r.kind === 'on-dig-net') {
      setInvalid(false);
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
    <div className="dig-builtin-toolbar" role="toolbar" aria-label={labels.toolbar} data-testid="builtin-dig-toolbar" style={barStyle}>
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
      <span role="alert" data-testid="builtin-dig-toolbar-urn-error" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        {invalid ? labels.urnInvalid : ''}
      </span>
    </div>
  );
}
