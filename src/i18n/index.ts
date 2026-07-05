import { en } from '@/i18n/messages/en';
import { DEFAULT_LOCALE, type LocaleCode } from '@/i18n/locales';

/** A flat message catalog: stable id → localized string. */
export type Messages = Record<string, string>;

/**
 * Resolve the message catalog for a locale. Phase 0 ships a complete English catalog; other
 * locales fall back to English (the `IntlProvider` also uses `defaultLocale=en`), so the UI is
 * never blank/id-showing while the remaining catalogs are translated as a fast-follow.
 */
export function messagesFor(_locale: LocaleCode | string): Messages {
  // Additional catalogs slot in here as they are translated (keyed by locale code).
  return en;
}

export { DEFAULT_LOCALE };
