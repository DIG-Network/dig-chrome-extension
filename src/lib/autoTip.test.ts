import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOTIP_CONFIG,
  DEFAULT_AUTOTIP_AMOUNT_DIG,
  AUTOTIP_MODES,
  isAutoTipMode,
  isValidTipAmount,
  normalizeAutoTipConfig,
  isAutoTipConfigured,
  resolveTipAmount,
  type AutoTipConfig,
} from '@/lib/autoTip';

describe('autoTip config model (#379)', () => {
  it('defaults to OFF so tipping is strictly opt-in (§6.0)', () => {
    expect(DEFAULT_AUTOTIP_CONFIG.enabled).toBe(false);
    expect(isAutoTipConfigured(DEFAULT_AUTOTIP_CONFIG)).toBe(false);
  });

  it('ships exactly the two documented modes', () => {
    expect(AUTOTIP_MODES).toEqual(['per-site-per-day', 'per-day-period']);
    expect(isAutoTipMode('per-site-per-day')).toBe(true);
    expect(isAutoTipMode('per-day-period')).toBe(true);
    expect(isAutoTipMode('weekly')).toBe(false);
    expect(isAutoTipMode(undefined)).toBe(false);
  });

  it('validates tip amounts — positive finite decimals only', () => {
    expect(isValidTipAmount('1')).toBe(true);
    expect(isValidTipAmount('0.5')).toBe(true);
    expect(isValidTipAmount('0')).toBe(false);
    expect(isValidTipAmount('-1')).toBe(false);
    expect(isValidTipAmount('')).toBe(false);
    expect(isValidTipAmount('abc')).toBe(false);
    expect(isValidTipAmount('1.2.3')).toBe(false);
  });

  it('is "configured" (hiding the manual prompt) exactly when enabled', () => {
    expect(isAutoTipConfigured({ ...DEFAULT_AUTOTIP_CONFIG, enabled: true })).toBe(true);
    expect(isAutoTipConfigured({ ...DEFAULT_AUTOTIP_CONFIG, enabled: false })).toBe(false);
  });

  describe('normalizeAutoTipConfig — defends against any persisted shape', () => {
    it('returns defaults for garbage / undefined', () => {
      expect(normalizeAutoTipConfig(undefined)).toEqual(DEFAULT_AUTOTIP_CONFIG);
      expect(normalizeAutoTipConfig('nope')).toEqual(DEFAULT_AUTOTIP_CONFIG);
      expect(normalizeAutoTipConfig(42)).toEqual(DEFAULT_AUTOTIP_CONFIG);
    });

    it('keeps valid fields and repairs invalid ones', () => {
      const raw = { enabled: true, amountDig: '2.5', mode: 'per-day-period', perSiteOverrides: {} };
      expect(normalizeAutoTipConfig(raw)).toEqual({
        enabled: true,
        amountDig: '2.5',
        mode: 'per-day-period',
        perSiteOverrides: {},
      });
      // Bad amount + bad mode fall back to defaults; enabled coerces to strict boolean.
      const bad = normalizeAutoTipConfig({ enabled: 'yes', amountDig: '-5', mode: 'hourly' });
      expect(bad.enabled).toBe(false);
      expect(bad.amountDig).toBe(DEFAULT_AUTOTIP_AMOUNT_DIG);
      expect(bad.mode).toBe('per-site-per-day');
    });

    it('keeps only valid per-site overrides', () => {
      const cfg = normalizeAutoTipConfig({
        perSiteOverrides: { good: '3', zero: '0', junk: 'x', alsoGood: '0.25' },
      });
      expect(cfg.perSiteOverrides).toEqual({ good: '3', alsoGood: '0.25' });
    });
  });

  describe('resolveTipAmount', () => {
    const cfg: AutoTipConfig = {
      enabled: true,
      amountDig: '1',
      mode: 'per-site-per-day',
      perSiteOverrides: { store_a: '5' },
    };
    it('uses a valid per-site override when present', () => {
      expect(resolveTipAmount(cfg, 'store_a')).toBe('5');
    });
    it('falls back to the default amount otherwise', () => {
      expect(resolveTipAmount(cfg, 'store_b')).toBe('1');
    });
  });
});
