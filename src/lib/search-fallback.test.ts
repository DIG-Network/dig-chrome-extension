import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SEARCH_FALLBACK_PRESETS,
  SEARCH_FALLBACK_KEY,
  DEFAULT_SEARCH_FALLBACK,
  DIG_SEARCH_MANIFEST_URL,
  buildFallbackSearchUrl,
  matchDigSearchSentinel,
  decideSearchRoute,
  getFallbackTemplate,
} from '@/lib/search-fallback';

const STORE = 'a'.repeat(64);

function mockStorage(seed: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...seed };
  (chrome as unknown as { storage: unknown }).storage = {
    local: {
      get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  return store;
}

describe('search-fallback presets + defaults', () => {
  it('DuckDuckGo is the first preset and the default (loop-free, private)', () => {
    expect(SEARCH_FALLBACK_PRESETS[0].id).toBe('duckduckgo');
    expect(DEFAULT_SEARCH_FALLBACK).toBe('https://duckduckgo.com/?q=%s');
  });

  it('ships Google/Brave/Bing presets, each a %s template', () => {
    const ids = SEARCH_FALLBACK_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['duckduckgo', 'google', 'brave', 'bing']));
    for (const p of SEARCH_FALLBACK_PRESETS) expect(p.template).toContain('%s');
  });

  it('the manifest search_url is an HTTPS DIG-domain sentinel with the {searchTerms} placeholder', () => {
    expect(DIG_SEARCH_MANIFEST_URL).toBe('https://dig.net/dig-search?q={searchTerms}');
  });
});

describe('buildFallbackSearchUrl', () => {
  it('interpolates + URL-encodes the query at %s', () => {
    expect(buildFallbackSearchUrl('https://duckduckgo.com/?q=%s', 'a b&c')).toBe(
      'https://duckduckgo.com/?q=a%20b%26c',
    );
  });
  it('falls back to DuckDuckGo when the template has no %s', () => {
    expect(buildFallbackSearchUrl('https://broken.example/', 'cats')).toBe('https://duckduckgo.com/?q=cats');
    expect(buildFallbackSearchUrl(null, 'cats')).toBe('https://duckduckgo.com/?q=cats');
  });
});

describe('matchDigSearchSentinel', () => {
  it('extracts the decoded query from a sentinel navigation', () => {
    expect(matchDigSearchSentinel('https://dig.net/dig-search?q=chia%3A%2F%2F' + STORE)).toBe('chia://' + STORE);
    expect(matchDigSearchSentinel('https://www.dig.net/dig-search?q=hello+world')).toBe('hello world');
  });
  it('returns null for a non-sentinel URL', () => {
    expect(matchDigSearchSentinel('https://dig.net/other?q=x')).toBeNull();
    expect(matchDigSearchSentinel('https://example.com/dig-search?q=x')).toBeNull();
    expect(matchDigSearchSentinel('')).toBeNull();
  });
});

describe('decideSearchRoute — DIG vs configurable web fallback (#362 Tier 4)', () => {
  const FB = 'https://duckduckgo.com/?q=%s';

  it('a DIG address routes to a chia:// load (via the local node)', () => {
    const r = decideSearchRoute(`chia://${STORE}`, FB);
    expect(r.kind).toBe('chia');
    if (r.kind === 'chia') expect(r.chiaUrl).toContain(STORE);
  });

  it('a urn:dig:chia: address routes to a chia:// load', () => {
    expect(decideSearchRoute(`urn:dig:chia:${STORE}`, FB).kind).toBe('chia');
  });

  it('an on.dig.net / .dig shorthand routes to an on-dig-net (HEAD→URN) resolution', () => {
    expect(decideSearchRoute('shop.on.dig.net', FB)).toEqual({ kind: 'on-dig-net', host: 'shop.on.dig.net' });
    expect(decideSearchRoute('alice.dig', FB)).toEqual({ kind: 'on-dig-net', host: 'alice.on.dig.net' });
  });

  it('a plain URL redirects to that URL (not a search)', () => {
    expect(decideSearchRoute('https://example.com', FB)).toEqual({ kind: 'redirect', url: 'https://example.com' });
  });

  it('free text redirects to the configured fallback search engine (loop-free)', () => {
    expect(decideSearchRoute('best chia wallet', FB)).toEqual({
      kind: 'redirect',
      url: 'https://duckduckgo.com/?q=best%20chia%20wallet',
    });
  });

  it('free text honors a custom fallback engine template', () => {
    expect(decideSearchRoute('cats', 'https://search.brave.com/search?q=%s')).toEqual({
      kind: 'redirect',
      url: 'https://search.brave.com/search?q=cats',
    });
  });
});

describe('getFallbackTemplate', () => {
  beforeEach(() => mockStorage());

  it('returns the default when unset', async () => {
    mockStorage();
    expect(await getFallbackTemplate()).toBe(DEFAULT_SEARCH_FALLBACK);
  });

  it('returns the persisted template when a valid %s template is stored', async () => {
    mockStorage({ [SEARCH_FALLBACK_KEY]: 'https://www.google.com/search?q=%s' });
    expect(await getFallbackTemplate()).toBe('https://www.google.com/search?q=%s');
  });

  it('ignores a stored template lacking %s (falls back to default)', async () => {
    mockStorage({ [SEARCH_FALLBACK_KEY]: 'https://broken/' });
    expect(await getFallbackTemplate()).toBe(DEFAULT_SEARCH_FALLBACK);
  });
});
