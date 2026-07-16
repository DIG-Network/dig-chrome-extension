import { describe, it, expect } from 'vitest';
import {
  UPDATE_CHANNELS,
  DEFAULT_UPDATE_CHANNEL,
  normalizeChannel,
  channelOptionLabelId,
  channelDescriptionId,
} from '@/lib/updater-channel';
import { feedManifestUrl } from '@/lib/feed-manifest';
import { en } from '@/i18n/messages/en';

describe('updater-channel', () => {
  it('offers stable first (the safe default leads) and both channels', () => {
    expect(UPDATE_CHANNELS).toEqual(['stable', 'nightly']);
    expect(DEFAULT_UPDATE_CHANNEL).toBe('stable');
  });

  describe('normalizeChannel', () => {
    it('passes through the two known channels', () => {
      expect(normalizeChannel('stable')).toBe('stable');
      expect(normalizeChannel('nightly')).toBe('nightly');
    });

    it('maps the legacy "alpha" stream to nightly (canonical alias, #591)', () => {
      expect(normalizeChannel('alpha')).toBe('nightly');
    });

    it('falls back to the safe default for unknown/absent tokens (never throws)', () => {
      expect(normalizeChannel(null)).toBe('stable');
      expect(normalizeChannel(undefined)).toBe('stable');
      expect(normalizeChannel('')).toBe('stable');
      expect(normalizeChannel('some-future-channel')).toBe('stable');
    });
  });

  describe('label ids resolve to real, non-empty English copy', () => {
    it.each(UPDATE_CHANNELS)('channel "%s" has an option + description message', (channel) => {
      expect(en[channelOptionLabelId(channel)]).toBeTruthy();
      expect(en[channelDescriptionId(channel)]).toBeTruthy();
    });

    it('picks distinct ids per channel', () => {
      expect(channelOptionLabelId('stable')).not.toBe(channelOptionLabelId('nightly'));
      expect(channelDescriptionId('stable')).not.toBe(channelDescriptionId('nightly'));
    });
  });

  describe('feedManifestUrl', () => {
    it('routes each channel to its own per-channel manifest path (#591)', () => {
      expect(feedManifestUrl('stable')).toBe('https://updates.dig.net/v1/stable/manifest.json');
      expect(feedManifestUrl('nightly')).toBe('https://updates.dig.net/v1/nightly/manifest.json');
    });
  });
});
