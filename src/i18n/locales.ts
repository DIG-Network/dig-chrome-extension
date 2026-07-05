/**
 * The ecosystem's standard locale set (§6.6) — the same 14 the hub carries. Every locale ships a
 * complete, translated message catalog (kept honest by `locales.test.ts`'s completeness gate);
 * locale detection + a persisted selector + an `IntlProvider` English fallback (for any code that
 * somehow isn't recognized) are wired so every string is externalized. This module is the single
 * source of truth for the supported set + detection.
 */

/** The 14 supported locales (BCP-47), English first. */
export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
  { code: 'ru', label: 'Русский' },
  { code: 'es', label: 'Español' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'hi', label: 'हिन्दी' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

/** The default + fallback locale. */
export const DEFAULT_LOCALE: LocaleCode = 'en';

const CODES = new Set<string>(LOCALES.map((l) => l.code));

/** True if `code` is one of the supported locales. */
export function isSupportedLocale(code: string | null | undefined): code is LocaleCode {
  return typeof code === 'string' && CODES.has(code);
}

/**
 * Detect the best supported locale from a list of preferred tags (e.g. `navigator.languages`).
 * Matches an exact tag first, then the base language (`en-GB` → `en`), else the default.
 */
export function detectLocale(preferred: readonly string[] | undefined): LocaleCode {
  for (const raw of preferred || []) {
    const tag = String(raw || '');
    if (isSupportedLocale(tag)) return tag;
    const base = tag.split('-')[0];
    if (isSupportedLocale(base)) return base;
    // Match a region-specific supported locale by base (e.g. `zh` → `zh-CN`).
    const byBase = LOCALES.find((l) => l.code.split('-')[0] === base);
    if (byBase) return byBase.code;
  }
  return DEFAULT_LOCALE;
}
