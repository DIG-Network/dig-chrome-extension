import { describe, it, expect } from 'vitest';
import { THEME_MODES, DEFAULT_THEME_MODE, isThemeMode, resolveEffectiveTheme, nextTheme } from '@/lib/theme';

describe('theme (#111)', () => {
  it('ships light/dark/system, defaulting to light (#211 — the original white theme is the default)', () => {
    expect(THEME_MODES).toEqual(['light', 'dark', 'system']);
    // #211 regression: a fresh install with no stored preference must render the ORIGINAL
    // light/white theme — NOT `system` (which would paint dark on a dark-OS). Default is an
    // EXPLICIT light so a dark-OS user still starts light until they opt into dark/system.
    expect(DEFAULT_THEME_MODE).toBe('light');
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

  it('nextTheme flips the painted light/dark to the opposite EXPLICIT mode (#429 one-tap toggle)', () => {
    // The quick toggle always commits an explicit light/dark (never `system`), so it overrides + persists.
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });
});
