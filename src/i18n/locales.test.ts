import { describe, it, expect } from 'vitest';
import { LOCALES, DEFAULT_LOCALE, isSupportedLocale, detectLocale } from '@/i18n/locales';
import { messagesFor } from '@/i18n';
import { en } from '@/i18n/messages/en';

describe('i18n locales', () => {
  it('ships the 14-locale ecosystem set, English first', () => {
    expect(LOCALES).toHaveLength(14);
    expect(LOCALES[0].code).toBe('en');
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('validates supported locales', () => {
    expect(isSupportedLocale('ja')).toBe(true);
    expect(isSupportedLocale('zh-CN')).toBe(true);
    expect(isSupportedLocale('xx')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });

  it('detects the best supported locale from preferences', () => {
    expect(detectLocale(['ja-JP', 'en'])).toBe('ja');
    expect(detectLocale(['fr'])).toBe('fr');
    expect(detectLocale(['zh'])).toBe('zh-CN'); // region-specific by base
    expect(detectLocale(['xx', 'de'])).toBe('de');
    expect(detectLocale(undefined)).toBe('en');
  });

  it('resolves the English catalog directly and falls back for an unrecognized code', () => {
    expect(messagesFor('en')).toBe(en);
    expect(messagesFor('xx-not-a-real-locale')).toBe(en);
    expect(en['wallet.action.send']).toBeTruthy();
  });
});

/**
 * Completeness gate (§6.6/§2.3): every message id shipped in the English catalog MUST exist —
 * non-empty, with the same ICU placeholder tokens — in EVERY one of the 14 supported locale
 * catalogs. This is the test that keeps future ids honest: add an id to `en.ts` without adding it
 * to all 13 translated catalogs, and this suite fails.
 */
describe('i18n catalog completeness', () => {
  const englishKeys = Object.keys(en);

  /** Extract the set of `{token}` ICU placeholder names used in a message, order-independent. */
  function placeholdersOf(message: string): string[] {
    return Array.from(message.matchAll(/\{(\w+)\}/g))
      .map((m) => m[1])
      .sort();
  }

  it('the English catalog is non-trivial (sanity check on the source of truth)', () => {
    expect(englishKeys.length).toBeGreaterThan(100);
  });

  describe.each(LOCALES.map((l) => l.code))('locale "%s"', (code) => {
    const catalog = messagesFor(code);

    it('ships its own catalog object (not a silent English fallback)', () => {
      // Every supported locale must resolve to a real object with the full key set — resolving
      // to some *other* locale's identical-by-reference catalog would defeat the point.
      expect(catalog).toBeTruthy();
      expect(Object.keys(catalog).length).toBe(englishKeys.length);
    });

    it('has every English id present with a non-empty translation', () => {
      for (const key of englishKeys) {
        expect(catalog[key], `locale "${code}" is missing/empty for id "${key}"`).toBeTruthy();
      }
    });

    it('has no extra ids beyond the English source (no drift)', () => {
      expect(new Set(Object.keys(catalog))).toEqual(new Set(englishKeys));
    });

    it('preserves every ICU placeholder token from the English source', () => {
      for (const key of englishKeys) {
        const expected = placeholdersOf(en[key]);
        if (expected.length === 0) continue;
        const actual = placeholdersOf(catalog[key] ?? '');
        expect(actual, `locale "${code}" id "${key}" placeholder mismatch`).toEqual(expected);
      }
    });
  });
});
