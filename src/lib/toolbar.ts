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
 * the badge state, and a compact localized label set; the content-script glue does the DOM / shadow-
 * root mounting + native-grey styling. Pure + DOM-free → unit-tested.
 *
 * i18n note: the labels live in a small self-contained table here (not the full shell catalog)
 * BECAUSE this runs as a content script on EVERY page and must stay lean — pulling in all 14
 * shell catalogs would bloat every page load. The brand phrase ("Verified on Chia") is preserved
 * verbatim across all locales per §6.6.
 */
import { readServeHeaders, type ServeVerdict } from '@/lib/dig-serve-headers';
import { detectLocale, type LocaleCode } from '@/i18n/locales';
import { parseOpenUrnInput, buildContentViewUrl } from '@/lib/open-urn';

/** chrome.storage.local key persisting the toolbar toggle. */
export const TOOLBAR_ENABLED_KEY = 'toolbar.enabled';
/** Default OFF — the toolbar is opt-in (it injects into EVERY page, so it must not appear unasked). */
export const TOOLBAR_ENABLED_DEFAULT = false;

/** #293 — the single button's target: the fullscreen extension surface (its own Home tab, no
 *  sub-view deep-link — this button just "opens the extension", it does not pick a screen). */
export const TOOLBAR_OPEN_PAGE = 'app.html';

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

/** The outcome of resolving what the toolbar's URN bar should do on Enter (#293). */
export interface UrnBarSubmitResult {
  /** True when `raw` parsed to a valid DIG address. */
  ok: boolean;
  /** The canonical `chia://` URL to hand to the background `navigateToDigUrl` action — set only
   *  when `ok`. `null` for empty/invalid input, so the caller can show an inline error instead of
   *  navigating. */
  url: string | null;
}

/**
 * Resolve the toolbar's dedicated URN-bar submit: parse the typed value against the single shared
 * URN grammar (reused via `open-urn.ts`'s `parseOpenUrnInput`, itself built on `parseURN`) and, when
 * valid, build the canonical `chia://` URL (`buildContentViewUrl`) to hand to the background
 * `navigateToDigUrl` action — the SAME §5.3 node-or-sandbox path (`handleDigUrlNavigation`) the #289
 * nav and the `dig` omnibox already use. There is no second resolve/decrypt implementation here.
 */
export function resolveUrnBarSubmit(raw: string): UrnBarSubmitResult {
  const parsed = parseOpenUrnInput(raw);
  if (!parsed) return { ok: false, url: null };
  return { ok: true, url: buildContentViewUrl(parsed) };
}

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
  },
  'zh-CN': {
    toolbar: 'DIG 工具栏',
    urnLabel: 'chia:// 地址或 DIG URN',
    urnPlaceholder: '输入 chia:// 地址或 DIG URN',
    urnInvalid: '不是有效的 chia:// 地址或 DIG URN。',
    open: '打开 DIG 扩展',
    verified: VERIFIED,
    local: '从本地加载',
  },
  'zh-TW': {
    toolbar: 'DIG 工具列',
    urnLabel: 'chia:// 位址或 DIG URN',
    urnPlaceholder: '輸入 chia:// 位址或 DIG URN',
    urnInvalid: '不是有效的 chia:// 位址或 DIG URN。',
    open: '開啟 DIG 擴充功能',
    verified: VERIFIED,
    local: '從本機載入',
  },
  ko: {
    toolbar: 'DIG 도구 모음',
    urnLabel: 'chia:// 주소 또는 DIG URN',
    urnPlaceholder: 'chia:// 주소 또는 DIG URN 입력',
    urnInvalid: '유효한 chia:// 주소 또는 DIG URN이 아닙니다.',
    open: 'DIG 확장 프로그램 열기',
    verified: VERIFIED,
    local: '로컬에서 로드됨',
  },
  ja: {
    toolbar: 'DIG ツールバー',
    urnLabel: 'chia:// アドレスまたは DIG URN',
    urnPlaceholder: 'chia:// アドレスまたは DIG URN を入力',
    urnInvalid: '有効な chia:// アドレスまたは DIG URN ではありません。',
    open: 'DIG 拡張機能を開く',
    verified: VERIFIED,
    local: 'ローカルから読み込み',
  },
  ru: {
    toolbar: 'Панель DIG',
    urnLabel: 'адрес chia:// или DIG URN',
    urnPlaceholder: 'Введите адрес chia:// или DIG URN',
    urnInvalid: 'Неверный адрес chia:// или DIG URN.',
    open: 'Открыть расширение DIG',
    verified: VERIFIED,
    local: 'Загружено локально',
  },
  es: {
    toolbar: 'Barra DIG',
    urnLabel: 'dirección chia:// o URN de DIG',
    urnPlaceholder: 'Introduce una dirección chia:// o un URN de DIG',
    urnInvalid: 'No es una dirección chia:// ni un URN de DIG válidos.',
    open: 'Abrir la extensión DIG',
    verified: VERIFIED,
    local: 'Cargado localmente',
  },
  'pt-BR': {
    toolbar: 'Barra DIG',
    urnLabel: 'endereço chia:// ou URN do DIG',
    urnPlaceholder: 'Digite um endereço chia:// ou um URN do DIG',
    urnInvalid: 'Não é um endereço chia:// ou URN do DIG válido.',
    open: 'Abrir a extensão DIG',
    verified: VERIFIED,
    local: 'Carregado localmente',
  },
  fr: {
    toolbar: 'Barre DIG',
    urnLabel: 'adresse chia:// ou URN DIG',
    urnPlaceholder: 'Saisissez une adresse chia:// ou un URN DIG',
    urnInvalid: "Adresse chia:// ou URN DIG non valide.",
    open: "Ouvrir l'extension DIG",
    verified: VERIFIED,
    local: 'Chargé en local',
  },
  de: {
    toolbar: 'DIG-Leiste',
    urnLabel: 'chia://-Adresse oder DIG-URN',
    urnPlaceholder: 'chia://-Adresse oder DIG-URN eingeben',
    urnInvalid: 'Keine gültige chia://-Adresse oder DIG-URN.',
    open: 'DIG-Erweiterung öffnen',
    verified: VERIFIED,
    local: 'Lokal geladen',
  },
  tr: {
    toolbar: 'DIG araç çubuğu',
    urnLabel: 'chia:// adresi veya DIG URN',
    urnPlaceholder: 'Bir chia:// adresi veya DIG URN girin',
    urnInvalid: 'Geçerli bir chia:// adresi veya DIG URN değil.',
    open: 'DIG uzantısını aç',
    verified: VERIFIED,
    local: 'Yerelden yüklendi',
  },
  vi: {
    toolbar: 'Thanh DIG',
    urnLabel: 'địa chỉ chia:// hoặc DIG URN',
    urnPlaceholder: 'Nhập địa chỉ chia:// hoặc DIG URN',
    urnInvalid: 'Không phải địa chỉ chia:// hoặc DIG URN hợp lệ.',
    open: 'Mở tiện ích DIG',
    verified: VERIFIED,
    local: 'Đã tải từ máy',
  },
  id: {
    toolbar: 'Bilah DIG',
    urnLabel: 'alamat chia:// atau URN DIG',
    urnPlaceholder: 'Masukkan alamat chia:// atau URN DIG',
    urnInvalid: 'Bukan alamat chia:// atau URN DIG yang valid.',
    open: 'Buka ekstensi DIG',
    verified: VERIFIED,
    local: 'Dimuat dari lokal',
  },
  hi: {
    toolbar: 'DIG टूलबार',
    urnLabel: 'chia:// पता या DIG URN',
    urnPlaceholder: 'chia:// पता या DIG URN दर्ज करें',
    urnInvalid: 'मान्य chia:// पता या DIG URN नहीं है।',
    open: 'DIG एक्सटेंशन खोलें',
    verified: VERIFIED,
    local: 'लोकल से लोड किया गया',
  },
};

/**
 * Resolve the toolbar's labels for the user's locale (from `navigator.languages` or a persisted
 * preference), falling back to English for any unsupported code.
 */
export function toolbarLabels(preferred?: readonly string[]): ToolbarLabels {
  return LABELS[detectLocale(preferred)] ?? LABELS.en;
}
