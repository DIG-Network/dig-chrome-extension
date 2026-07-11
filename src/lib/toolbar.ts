/**
 * toolbar — pure view-model for the #292 injected page toolbar.
 *
 * When the persisted toggle is ON, a content script injects a native-looking, `chia://`-aware
 * toolbar atop EVERY page (shadow-DOM isolated). The toolbar carries per-page icons that open the
 * full-page extension surfaces (#140/#141) — Wallet / DIG Shields / Control Panel — plus two live
 * badges derived from the node's serve headers (#289): "Verified on Chia" (`X-Dig-Verified`) and
 * "Loaded from local" (`X-Dig-Source: local`). This module owns the toggle key/default, the
 * icon→page map, the inject-or-not decision, the badge state, and a compact localized label set;
 * the content-script glue does the DOM / shadow-root mounting. Pure + DOM-free → unit-tested.
 *
 * i18n note: the labels live in a small self-contained table here (not the full shell catalog)
 * BECAUSE this runs as a content script on EVERY page and must stay lean — pulling in all 14
 * shell catalogs would bloat every page load. The two brand phrases ("Verified on Chia", "DIG
 * Shields") are preserved verbatim across all locales per §6.6 (brand/scheme literals).
 */
import { readServeHeaders, type ServeVerdict } from '@/lib/dig-serve-headers';
import { detectLocale, type LocaleCode } from '@/i18n/locales';

/** chrome.storage.local key persisting the toolbar toggle. */
export const TOOLBAR_ENABLED_KEY = 'toolbar.enabled';
/** Default OFF — the toolbar is opt-in (it injects into EVERY page, so it must not appear unasked). */
export const TOOLBAR_ENABLED_DEFAULT = false;

/** A toolbar icon that opens a full-page extension surface (an `app.html` deep-link, #140/#141). */
export interface ToolbarItem {
  id: 'wallet' | 'shields' | 'control';
  /** `app.html` hash deep-link; the glue resolves it to a `chrome-extension://` URL. */
  page: string;
  glyph: string;
}

/**
 * The toolbar's icons, in visual order: Wallet, DIG Shields, Control Panel. The `page` hashes match
 * the React shell's route model (`app/tabs.ts`): `#wallet`, `#network/shield`, `#network/control`
 * (the last mirrors the native DIG Browser's `dig://control`).
 */
export const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { id: 'wallet', page: 'app.html#wallet', glyph: '\u{1F45B}' }, // 👛
  { id: 'shields', page: 'app.html#network/shield', glyph: '\u{1F6E1}️' }, // 🛡️
  { id: 'control', page: 'app.html#network/control', glyph: '⚙️' }, // ⚙️
];

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

/** The toolbar's localized string set. */
export interface ToolbarLabels {
  /** ARIA label for the injected bar. */
  toolbar: string;
  wallet: string;
  /** Brand phrase — verbatim across locales. */
  shields: string;
  control: string;
  /** Brand phrase — verbatim across locales. */
  verified: string;
  local: string;
}

// Brand phrases kept verbatim in every locale (§6.6). "Verified on Chia" also matches the
// dig-viewer's canonical VERIFIED_LABEL so the verdict reads identically across surfaces.
const VERIFIED = 'Verified on Chia';
const SHIELDS = 'DIG Shields';

const LABELS: Record<LocaleCode, ToolbarLabels> = {
  en: { toolbar: 'DIG toolbar', wallet: 'Wallet', shields: SHIELDS, control: 'Control Panel', verified: VERIFIED, local: 'Loaded from local' },
  'zh-CN': { toolbar: 'DIG 工具栏', wallet: '钱包', shields: SHIELDS, control: '控制面板', verified: VERIFIED, local: '从本地加载' },
  'zh-TW': { toolbar: 'DIG 工具列', wallet: '錢包', shields: SHIELDS, control: '控制面板', verified: VERIFIED, local: '從本機載入' },
  ko: { toolbar: 'DIG 도구 모음', wallet: '지갑', shields: SHIELDS, control: '제어판', verified: VERIFIED, local: '로컬에서 로드됨' },
  ja: { toolbar: 'DIG ツールバー', wallet: 'ウォレット', shields: SHIELDS, control: 'コントロールパネル', verified: VERIFIED, local: 'ローカルから読み込み' },
  ru: { toolbar: 'Панель DIG', wallet: 'Кошелёк', shields: SHIELDS, control: 'Панель управления', verified: VERIFIED, local: 'Загружено локально' },
  es: { toolbar: 'Barra DIG', wallet: 'Cartera', shields: SHIELDS, control: 'Panel de control', verified: VERIFIED, local: 'Cargado localmente' },
  'pt-BR': { toolbar: 'Barra DIG', wallet: 'Carteira', shields: SHIELDS, control: 'Painel de controle', verified: VERIFIED, local: 'Carregado localmente' },
  fr: { toolbar: 'Barre DIG', wallet: 'Portefeuille', shields: SHIELDS, control: 'Panneau de configuration', verified: VERIFIED, local: 'Chargé en local' },
  de: { toolbar: 'DIG-Leiste', wallet: 'Wallet', shields: SHIELDS, control: 'Systemsteuerung', verified: VERIFIED, local: 'Lokal geladen' },
  tr: { toolbar: 'DIG araç çubuğu', wallet: 'Cüzdan', shields: SHIELDS, control: 'Kontrol paneli', verified: VERIFIED, local: 'Yerelden yüklendi' },
  vi: { toolbar: 'Thanh DIG', wallet: 'Ví', shields: SHIELDS, control: 'Bảng điều khiển', verified: VERIFIED, local: 'Đã tải từ máy' },
  id: { toolbar: 'Bilah DIG', wallet: 'Dompet', shields: SHIELDS, control: 'Panel kontrol', verified: VERIFIED, local: 'Dimuat dari lokal' },
  hi: { toolbar: 'DIG टूलबार', wallet: 'वॉलेट', shields: SHIELDS, control: 'कंट्रोल पैनल', verified: VERIFIED, local: 'लोकल से लोड किया गया' },
};

/**
 * Resolve the toolbar's labels for the user's locale (from `navigator.languages` or a persisted
 * preference), falling back to English for any unsupported code.
 */
export function toolbarLabels(preferred?: readonly string[]): ToolbarLabels {
  return LABELS[detectLocale(preferred)] ?? LABELS.en;
}
