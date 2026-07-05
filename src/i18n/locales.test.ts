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

  it('resolves a catalog (English fallback) with every id present', () => {
    expect(messagesFor('en')).toBe(en);
    expect(messagesFor('ja')).toBe(en); // fallback in Phase 0
    expect(en['wallet.action.send']).toBeTruthy();
  });
});
