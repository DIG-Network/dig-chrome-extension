import { en } from '@/i18n/messages/en';
import { zhCN } from '@/i18n/messages/zh-CN';
import { zhTW } from '@/i18n/messages/zh-TW';
import { ko } from '@/i18n/messages/ko';
import { ja } from '@/i18n/messages/ja';
import { ru } from '@/i18n/messages/ru';
import { es } from '@/i18n/messages/es';
import { ptBR } from '@/i18n/messages/pt-BR';
import { fr } from '@/i18n/messages/fr';
import { de } from '@/i18n/messages/de';
import { tr } from '@/i18n/messages/tr';
import { vi } from '@/i18n/messages/vi';
import { id } from '@/i18n/messages/id';
import { hi } from '@/i18n/messages/hi';
import { DEFAULT_LOCALE, type LocaleCode } from '@/i18n/locales';

/** A flat message catalog: stable id → localized string. */
export type Messages = Record<string, string>;

/** Every supported locale's complete message catalog, keyed by locale code (§6.6). */
const CATALOGS: Record<LocaleCode, Messages> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ko,
  ja,
  ru,
  es,
  'pt-BR': ptBR,
  fr,
  de,
  tr,
  vi,
  id,
  hi,
};

/**
 * Resolve the message catalog for a locale. Every one of the 14 ecosystem locales ships a
 * complete catalog (kept honest by `locales.test.ts`'s completeness check); an unrecognized code
 * falls back to English (the `IntlProvider` also uses `defaultLocale=en`), so the UI is never
 * blank/id-showing.
 */
export function messagesFor(locale: LocaleCode | string): Messages {
  return CATALOGS[locale as LocaleCode] ?? en;
}

export { DEFAULT_LOCALE };
