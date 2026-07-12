/**
 * toolbar — pure view-model for the injected page toolbar (#292, restyled/rewired as native browser
 * chrome by #293).
 *
 * When the persisted toggle is ON, a content script injects a toolbar atop EVERY page (shadow-DOM
 * isolated), styled to read as NATIVE browser chrome (neutral grey, no DIG gradient/branding) rather
 * than a DIG-branded widget. It carries:
 *   - a dedicated `chia://`/URN address bar — NOT the page's own address bar — whose Enter path feeds
 *     the SAME §5.3 node-or-sandbox navigation the #289 nav + `dig` omnibox already use (this module's
 *     {@link resolveUrnBarSubmit} reuses the single shared `parseURN`/`buildContentViewUrl`
 *     canonicalizer via `open-urn.ts`; no second resolve/decrypt path);
 *   - two live badges derived from the node's serve headers (#289): "Verified on Chia"
 *     (`X-Dig-Verified`) and "Loaded from local" (`X-Dig-Source: local`);
 *   - ONE button that opens the fullscreen extension surface (`openExtensionPage`) — replacing the
 *     earlier per-page Wallet/Shields/Control icon row (#293 item 4).
 * The enable/disable toggle itself now lives at the TOP of the extension's Home tab (#293 item 3),
 * not the options page — `TOOLBAR_ENABLED_KEY` is unchanged so existing persisted state carries over.
 *
 * This module owns the toggle key/default, the inject-or-not decision, the URN-bar submit decision,
 * the badge state, the URN bar's OWN independent theme preference (#459 — `TOOLBAR_THEME_KEY` /
 * {@link resolveToolbarTheme}, decoupled from the main app theme in `theme.ts`/`uiSlice.ts`), and a
 * compact localized label set; the content-script glue does the DOM / shadow-root mounting +
 * native-grey styling. Pure + DOM-free → unit-tested.
 *
 * i18n note: the labels live in a small self-contained table here (not the full shell catalog)
 * BECAUSE this runs as a content script on EVERY page and must stay lean — pulling in all 14
 * shell catalogs would bloat every page load. The brand phrase ("Verified on Chia") is preserved
 * verbatim across all locales per §6.6.
 */
import { readServeHeaders, type ServeVerdict } from '@/lib/dig-serve-headers';
import { detectLocale, type LocaleCode } from '@/i18n/locales';
import { classifyDigInput } from '@/lib/dig-nav';

/** chrome.storage.local key persisting the toolbar toggle. */
export const TOOLBAR_ENABLED_KEY = 'toolbar.enabled';
/** Default OFF — the toolbar is opt-in (it injects into EVERY page, so it must not appear unasked). */
export const TOOLBAR_ENABLED_DEFAULT = false;

/** #293 — the single button's target: the fullscreen extension surface (its own Home tab, no
 *  sub-view deep-link — this button just "opens the extension", it does not pick a screen). */
export const TOOLBAR_OPEN_PAGE = 'app.html';

/**
 * #366 — the `chrome.commands` id for the show/hide keyboard shortcut, registered in
 * `manifest.json`'s `commands` map with a `suggested_key.default` matching
 * {@link TOOLBAR_TOGGLE_SHORTCUT_DEFAULT}. The background SW listens via
 * `chrome.commands.onCommand` and flips {@link TOOLBAR_ENABLED_KEY}; both toolbar mounts react
 * live through the existing `storage.onChanged` wiring — no new toggle path.
 */
export const TOOLBAR_TOGGLE_COMMAND = 'toggle-dig-toolbar';

/**
 * The cross-platform default shortcut shown in the URN-bar hint (#366 item 4) before a caller
 * resolves the ACTUAL bound key via `chrome.commands.getAll()` (only available to extension-page
 * contexts — a content script asks the SW). Matches manifest.json's `suggested_key.default`; the
 * user may rebind it at `chrome://extensions/shortcuts`, in which case the resolved shortcut wins.
 */
export const TOOLBAR_TOGGLE_SHORTCUT_DEFAULT = 'Alt+Shift+D';

/**
 * Should the toolbar inject on this page? Only when enabled AND the page is an ordinary top-frame
 * web page (`http`/`https`, which includes the node-served `dig.local` / loopback) — NEVER on the
 * extension's own pages, `chrome://`, `about:`, `view-source:`, or a sub-frame.
 */
export function shouldInjectToolbar(enabled: boolean, url: string | null | undefined, isTop = true): boolean {
  if (!enabled || !isTop) return false;
  return /^https?:\/\//i.test(String(url || ''));
}

/** Which badges the toolbar renders + their state. */
export interface BadgeState {
  verified: { show: boolean; ok: boolean };
  local: { show: boolean };
}

/**
 * Derive the toolbar badge state from a parsed serve verdict (#289 headers): the Verified badge
 * shows whenever the node returned a verdict (green when `true`, a warning state when `false`) and
 * is hidden on a non-node-served page; the "Loaded from local" badge shows only when the main
 * resource came from the synced local `.dig`.
 */
export function toolbarBadges(verdict: ServeVerdict | null | undefined): BadgeState {
  const v = verdict ?? { verified: null, root: null, source: null };
  return {
    verified: { show: v.verified !== null, ok: v.verified === true },
    local: { show: v.source === 'local' },
  };
}

/** Convenience: parse the served response's headers → badge state in one step. */
export function badgesFromHeaders(headers: Parameters<typeof readServeHeaders>[0]): BadgeState {
  return toolbarBadges(readServeHeaders(headers));
}

/**
 * The outcome of resolving what the toolbar's URN bar should do on Enter (#293/#306/#310/#362).
 * A discriminated union so the DOM/React glue routes each DIG-address FORM through the right
 * background action:
 *   - `urn` — a `chia://` / `urn:dig:chia:` / bare-hex / dig-dns `.dig` address that already parses
 *     to a canonical `chia://` URL → hand `url` to the `navigateToDigUrl` action (the SAME §5.4
 *     node-or-sandbox path #289/#291 use);
 *   - `on-dig-net` — an `*.on.dig.net` / `<name>.dig` subdomain that must be resolved HEAD→URN (#308)
 *     from the EXTENSION origin → hand `host` to the `navigateDigInput` action (the SW does the HEAD);
 *   - `{ ok: false }` — empty / non-DIG (a web URL or free text) → the caller shows an inline error
 *     (the URN bar accepts DIG addresses only).
 */
export type UrnBarSubmit =
  | { ok: true; kind: 'urn'; url: string }
  | { ok: true; kind: 'on-dig-net'; host: string }
  | { ok: false };

/**
 * Resolve the toolbar's dedicated URN-bar submit against the ONE shared entry classifier
 * ({@link classifyDigInput} in `dig-nav.ts`), so the injected + built-in toolbars accept EXACTLY the
 * forms every other entry tier does (raw `chia://`, `urn:dig:chia:`, a bare store id, a dig-dns
 * `<label>.dig`, and `*.on.dig.net` / `<name>.dig` shorthands) and route them through the identical
 * §5.4 node-or-sandbox path — no second resolve/decrypt implementation. A non-DIG value (a web URL
 * or free text) is rejected so the caller shows an inline error.
 */
export function resolveUrnBarSubmit(raw: string): UrnBarSubmit {
  const c = classifyDigInput(raw);
  if (c.kind === 'urn') return { ok: true, kind: 'urn', url: c.chiaUrl };
  if (c.kind === 'on-dig-net') return { ok: true, kind: 'on-dig-net', host: c.host };
  return { ok: false };
}

/** The toolbar's light/dark theme — matched to the browser via `prefers-color-scheme` (#306). */
export type ToolbarTheme = 'light' | 'dark';

/** Choose the toolbar theme from the OS/browser dark-mode signal (`prefers-color-scheme: dark`). */
export function toolbarTheme(prefersDark: boolean): ToolbarTheme {
  return prefersDark ? 'dark' : 'light';
}

/**
 * #459 — the URN bar's OWN independent theme preference, fully decoupled from the main app theme
 * (`uiSlice.theme` / persisted `wallet.settings.theme`, #111/#429). `system` follows the OS
 * `prefers-color-scheme` signal (same as the toolbar's pre-#459 always-follow-the-OS behavior);
 * `light`/`dark` are explicit, user-locked choices set by the #429 switcher.
 */
export const TOOLBAR_THEME_MODES = ['light', 'dark', 'system'] as const;
export type ToolbarThemeMode = (typeof TOOLBAR_THEME_MODES)[number];

/**
 * `chrome.storage.local` key persisting the URN bar's independent theme preference. Deliberately
 * a FLAT top-level key — same idiom as {@link TOOLBAR_ENABLED_KEY} — NOT a field inside the
 * `wallet.settings` blob `uiSlice`/`AppFooter` read/write for the main app theme, so the two
 * preferences can never cross-write each other even by an accidental read-modify-write merge.
 */
export const TOOLBAR_THEME_KEY = 'toolbar.theme';

/**
 * Default `system` — before #459 the toolbar ALWAYS painted from `prefers-color-scheme` directly
 * with no persisted preference at all, so defaulting the new independent state to `system`
 * reproduces that exact look for every existing user (no jarring first-run change).
 */
export const TOOLBAR_THEME_DEFAULT: ToolbarThemeMode = 'system';

const TOOLBAR_THEME_MODE_SET = new Set<string>(TOOLBAR_THEME_MODES);

/** True if `value` is one of the three supported URN-bar theme modes. */
export function isToolbarThemeMode(value: unknown): value is ToolbarThemeMode {
  return typeof value === 'string' && TOOLBAR_THEME_MODE_SET.has(value);
}

/**
 * Resolve the URN bar's independent theme preference to the concrete paint to apply: `system`
 * follows the caller-supplied OS signal (`prefers-color-scheme: dark`); `light`/`dark` pass
 * through unchanged. Mirrors `resolveEffectiveTheme` (`theme.ts`) in SHAPE only — this is a fully
 * separate resolver over a fully separate preference, so the URN bar never shares state (or an
 * import edge that could later grow one) with the main app theme (#459).
 */
export function resolveToolbarTheme(mode: ToolbarThemeMode, prefersDark: boolean): ToolbarTheme {
  if (mode === 'system') return toolbarTheme(prefersDark);
  return mode;
}

/**
 * The mode a one-tap light↔dark toggle on the URN bar flips TO, given the theme currently
 * PAINTED. Always an explicit `light`/`dark` — never `system` — so the #429 switcher locks in a
 * deterministic choice that overrides + persists (the tri-state `system` default is reachable
 * again only by clearing the pref; #459 keeps scope to the one-tap switcher, no fuller
 * toolbar-theme control).
 */
export function nextToolbarTheme(current: ToolbarTheme): ToolbarThemeMode {
  return current === 'dark' ? 'light' : 'dark';
}

/** The colour tokens the toolbar renders with, per theme. ONE palette source shared by the injected
 *  shadow-DOM bar (`dig-toolbar.ts`) and the built-in fullscreen React bar (`DigToolbar.tsx`) so the
 *  two mounts stay pixel-consistent (#306 item 2). Light = neutral Chrome grey; dark = Chrome's dark
 *  toolbar surface — NOT the DIG brand gradient (§5.5: it must read as browser chrome). */
export interface ToolbarPalette {
  bar: string;
  border: string;
  text: string;
  mark: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  placeholder: string;
  focus: string;
  badgeBg: string;
  badgeText: string;
  okBg: string;
  okText: string;
  warnBg: string;
  warnText: string;
  btn: string;
  btnHover: string;
}

export const TOOLBAR_PALETTES: Record<ToolbarTheme, ToolbarPalette> = {
  light: {
    bar: '#f1f3f4',
    border: '#dadce0',
    text: '#3c4043',
    mark: '#5f6368',
    inputBg: '#ffffff',
    inputBorder: '#dadce0',
    inputText: '#202124',
    placeholder: '#80868b',
    focus: '#1a73e8',
    badgeBg: '#e8eaed',
    badgeText: '#3c4043',
    okBg: '#e6f4ea',
    okText: '#137333',
    warnBg: '#fce8e6',
    warnText: '#c5221f',
    btn: '#5f6368',
    btnHover: 'rgba(0,0,0,0.06)',
  },
  dark: {
    bar: '#292a2d',
    border: '#3c4043',
    text: '#e8eaed',
    mark: '#9aa0a6',
    inputBg: '#202124',
    inputBorder: '#5f6368',
    inputText: '#e8eaed',
    placeholder: '#9aa0a6',
    focus: '#8ab4f8',
    badgeBg: '#3c4043',
    badgeText: '#e8eaed',
    okBg: '#0f5223',
    okText: '#81c995',
    warnBg: '#5c1a17',
    warnText: '#f28b82',
    btn: '#9aa0a6',
    btnHover: 'rgba(255,255,255,0.10)',
  },
};

/** The toolbar's localized string set. */
export interface ToolbarLabels {
  /** ARIA label for the injected bar. */
  toolbar: string;
  /** ARIA label for the URN/`chia://` input (distinct from the placeholder — #293). */
  urnLabel: string;
  /** Placeholder text making clear this is a URN bar, not the page's own address bar. */
  urnPlaceholder: string;
  /** Announced (aria-live) when Enter is pressed on an unparseable value. */
  urnInvalid: string;
  /** Aria-label/title for the single "open fullscreen extension" button. */
  open: string;
  /** Brand phrase — verbatim across locales. */
  verified: string;
  local: string;
  /** #366 — aria-label/title for the injected bar's hide (×) control. */
  hide: string;
  /** #366 item 4 — the muted keyboard-shortcut hint template shown in the URN bar; the literal
   *  `{key}` placeholder is substituted with the resolved (or default) shortcut string by
   *  {@link toolbarShortcutHint}. The key combo itself is NOT translated (a keyboard label, like a
   *  code identifier — §6.6 carve-out), only the surrounding phrase. */
  shortcutHint: string;
}

// Brand phrase kept verbatim in every locale (§6.6). "Verified on Chia" also matches the
// dig-viewer's canonical VERIFIED_LABEL so the verdict reads identically across surfaces.
const VERIFIED = 'Verified on Chia';

const LABELS: Record<LocaleCode, ToolbarLabels> = {
  en: {
    toolbar: 'DIG toolbar',
    urnLabel: 'chia:// address or DIG URN',
    urnPlaceholder: 'Enter a chia:// address or DIG URN',
    urnInvalid: 'Not a valid chia:// address or DIG URN.',
    open: 'Open DIG extension',
    verified: VERIFIED,
    local: 'Loaded from local',
    hide: 'Hide DIG toolbar',
    shortcutHint: '{key} to show/hide',
  },
  'zh-CN': {
    toolbar: 'DIG 工具栏',
    urnLabel: 'chia:// 地址或 DIG URN',
    urnPlaceholder: '输入 chia:// 地址或 DIG URN',
    urnInvalid: '不是有效的 chia:// 地址或 DIG URN。',
    open: '打开 DIG 扩展',
    verified: VERIFIED,
    local: '从本地加载',
    hide: '隐藏 DIG 工具栏',
    shortcutHint: '{key} 显示/隐藏',
  },
  'zh-TW': {
    toolbar: 'DIG 工具列',
    urnLabel: 'chia:// 位址或 DIG URN',
    urnPlaceholder: '輸入 chia:// 位址或 DIG URN',
    urnInvalid: '不是有效的 chia:// 位址或 DIG URN。',
    open: '開啟 DIG 擴充功能',
    verified: VERIFIED,
    local: '從本機載入',
    hide: '隱藏 DIG 工具列',
    shortcutHint: '{key} 顯示/隱藏',
  },
  ko: {
    toolbar: 'DIG 도구 모음',
    urnLabel: 'chia:// 주소 또는 DIG URN',
    urnPlaceholder: 'chia:// 주소 또는 DIG URN 입력',
    urnInvalid: '유효한 chia:// 주소 또는 DIG URN이 아닙니다.',
    open: 'DIG 확장 프로그램 열기',
    verified: VERIFIED,
    local: '로컬에서 로드됨',
    hide: 'DIG 도구 모음 숨기기',
    shortcutHint: '{key} 표시/숨기기',
  },
  ja: {
    toolbar: 'DIG ツールバー',
    urnLabel: 'chia:// アドレスまたは DIG URN',
    urnPlaceholder: 'chia:// アドレスまたは DIG URN を入力',
    urnInvalid: '有効な chia:// アドレスまたは DIG URN ではありません。',
    open: 'DIG 拡張機能を開く',
    verified: VERIFIED,
    local: 'ローカルから読み込み',
    hide: 'DIG ツールバーを非表示',
    shortcutHint: '{key} で表示/非表示',
  },
  ru: {
    toolbar: 'Панель DIG',
    urnLabel: 'адрес chia:// или DIG URN',
    urnPlaceholder: 'Введите адрес chia:// или DIG URN',
    urnInvalid: 'Неверный адрес chia:// или DIG URN.',
    open: 'Открыть расширение DIG',
    verified: VERIFIED,
    local: 'Загружено локально',
    hide: 'Скрыть панель DIG',
    shortcutHint: '{key} — показать/скрыть',
  },
  es: {
    toolbar: 'Barra DIG',
    urnLabel: 'dirección chia:// o URN de DIG',
    urnPlaceholder: 'Introduce una dirección chia:// o un URN de DIG',
    urnInvalid: 'No es una dirección chia:// ni un URN de DIG válidos.',
    open: 'Abrir la extensión DIG',
    verified: VERIFIED,
    local: 'Cargado localmente',
    hide: 'Ocultar la barra DIG',
    shortcutHint: '{key} para mostrar/ocultar',
  },
  'pt-BR': {
    toolbar: 'Barra DIG',
    urnLabel: 'endereço chia:// ou URN do DIG',
    urnPlaceholder: 'Digite um endereço chia:// ou um URN do DIG',
    urnInvalid: 'Não é um endereço chia:// ou URN do DIG válido.',
    open: 'Abrir a extensão DIG',
    verified: VERIFIED,
    local: 'Carregado localmente',
    hide: 'Ocultar a barra DIG',
    shortcutHint: '{key} para mostrar/ocultar',
  },
  fr: {
    toolbar: 'Barre DIG',
    urnLabel: 'adresse chia:// ou URN DIG',
    urnPlaceholder: 'Saisissez une adresse chia:// ou un URN DIG',
    urnInvalid: "Adresse chia:// ou URN DIG non valide.",
    open: "Ouvrir l'extension DIG",
    verified: VERIFIED,
    local: 'Chargé en local',
    hide: 'Masquer la barre DIG',
    shortcutHint: '{key} pour afficher/masquer',
  },
  de: {
    toolbar: 'DIG-Leiste',
    urnLabel: 'chia://-Adresse oder DIG-URN',
    urnPlaceholder: 'chia://-Adresse oder DIG-URN eingeben',
    urnInvalid: 'Keine gültige chia://-Adresse oder DIG-URN.',
    open: 'DIG-Erweiterung öffnen',
    verified: VERIFIED,
    local: 'Lokal geladen',
    hide: 'DIG-Leiste ausblenden',
    shortcutHint: '{key} zum Ein-/Ausblenden',
  },
  tr: {
    toolbar: 'DIG araç çubuğu',
    urnLabel: 'chia:// adresi veya DIG URN',
    urnPlaceholder: 'Bir chia:// adresi veya DIG URN girin',
    urnInvalid: 'Geçerli bir chia:// adresi veya DIG URN değil.',
    open: 'DIG uzantısını aç',
    verified: VERIFIED,
    local: 'Yerelden yüklendi',
    hide: 'DIG araç çubuğunu gizle',
    shortcutHint: 'Göstermek/gizlemek için {key}',
  },
  vi: {
    toolbar: 'Thanh DIG',
    urnLabel: 'địa chỉ chia:// hoặc DIG URN',
    urnPlaceholder: 'Nhập địa chỉ chia:// hoặc DIG URN',
    urnInvalid: 'Không phải địa chỉ chia:// hoặc DIG URN hợp lệ.',
    open: 'Mở tiện ích DIG',
    verified: VERIFIED,
    local: 'Đã tải từ máy',
    hide: 'Ẩn thanh DIG',
    shortcutHint: '{key} để hiện/ẩn',
  },
  id: {
    toolbar: 'Bilah DIG',
    urnLabel: 'alamat chia:// atau URN DIG',
    urnPlaceholder: 'Masukkan alamat chia:// atau URN DIG',
    urnInvalid: 'Bukan alamat chia:// atau URN DIG yang valid.',
    open: 'Buka ekstensi DIG',
    verified: VERIFIED,
    local: 'Dimuat dari lokal',
    hide: 'Sembunyikan bilah DIG',
    shortcutHint: '{key} untuk tampilkan/sembunyikan',
  },
  hi: {
    toolbar: 'DIG टूलबार',
    urnLabel: 'chia:// पता या DIG URN',
    urnPlaceholder: 'chia:// पता या DIG URN दर्ज करें',
    urnInvalid: 'मान्य chia:// पता या DIG URN नहीं है।',
    open: 'DIG एक्सटेंशन खोलें',
    verified: VERIFIED,
    local: 'लोकल से लोड किया गया',
    hide: 'DIG टूलबार छिपाएँ',
    shortcutHint: 'दिखाने/छिपाने के लिए {key}',
  },
};

/**
 * Resolve the toolbar's labels for the user's locale (from `navigator.languages` or a persisted
 * preference), falling back to English for any unsupported code.
 */
export function toolbarLabels(preferred?: readonly string[]): ToolbarLabels {
  return LABELS[detectLocale(preferred)] ?? LABELS.en;
}

/**
 * Build the muted keyboard-shortcut hint shown in the URN bar (#366 item 4): substitutes the
 * ACTUAL bound shortcut into `labels.shortcutHint`'s `{key}` placeholder when a caller resolved
 * one (via `chrome.commands.getAll()` — an extension-page-only API; a content script asks the SW,
 * see `ACTIONS.getToolbarShortcut`), else falls back to {@link TOOLBAR_TOGGLE_SHORTCUT_DEFAULT} —
 * the same default `manifest.json`'s `suggested_key.default` carries. Never blank: a still-loading
 * hint shows the default immediately, then swaps to the real binding once resolved.
 */
export function toolbarShortcutHint(labels: ToolbarLabels, shortcut: string | null | undefined): string {
  const key = shortcut && shortcut.trim() ? shortcut.trim() : TOOLBAR_TOGGLE_SHORTCUT_DEFAULT;
  return labels.shortcutHint.replace('{key}', key);
}
