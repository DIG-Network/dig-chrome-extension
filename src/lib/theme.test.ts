import { describe, it, expect } from 'vitest';
import { THEME_MODES, DEFAULT_THEME_MODE, isThemeMode, resolveEffectiveTheme } from '@/lib/theme';

describe('theme (#111)', () => {
  it('ships light/dark/system, defaulting to system', () => {
    expect(THEME_MODES).toEqual(['light', 'dark', 'system']);
    expect(DEFAULT_THEME_MODE).toBe('system');
  });

  it('validates a theme mode string', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('solarized')).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
    expect(isThemeMode(null)).toBe(false);
    expect(isThemeMode(42)).toBe(false);
  });

  it('resolves an explicit light/dark mode regardless of the OS preference', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('light', false)).toBe('light');
    expect(resolveEffectiveTheme('dark', true)).toBe('dark');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
  });

  it('resolves "system" from the OS prefers-color-scheme signal', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });
});
