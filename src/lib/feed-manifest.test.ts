import { describe, it, expect } from 'vitest';
import {
  parseFeedComponents,
  latestVersionFor,
  fetchFeedComponents,
  FeedManifestUnavailableError,
  UPDATE_FEED_MANIFEST_URL,
} from '@/lib/feed-manifest';

const SIGNED_MANIFEST = {
  manifest: {
    schema: 1,
    root_version: 1,
    sequence: 42,
    generated: 1730990000,
    expires: 1731100000,
    rollback_floor_build: 0,
    components: [
      { name: 'dig-node', version: '0.31.1', build: 311, artifacts: [] },
      { name: 'digstore', version: '1.2.0', build: 120, artifacts: [] },
    ],
  },
  signature: 'base64signature==',
};

describe('parseFeedComponents', () => {
  it('extracts {name, version} for every component, ignoring fields this reader does not need', () => {
    expect(parseFeedComponents(SIGNED_MANIFEST)).toEqual([
      { name: 'dig-node', version: '0.31.1' },
      { name: 'digstore', version: '1.2.0' },
    ]);
  });

  it('tolerates a missing/malformed envelope, manifest, or components array', () => {
    expect(parseFeedComponents(null)).toEqual([]);
    expect(parseFeedComponents({})).toEqual([]);
    expect(parseFeedComponents({ manifest: {} })).toEqual([]);
    expect(parseFeedComponents({ manifest: { components: 'nope' } })).toEqual([]);
  });

  it('drops a component missing a name or version rather than throwing', () => {
    const partial = { manifest: { components: [{ name: 'dig-node' }, { version: '1.0.0' }, null] } };
    expect(parseFeedComponents(partial)).toEqual([]);
  });
});

describe('latestVersionFor', () => {
  const components = parseFeedComponents(SIGNED_MANIFEST);

  it('finds a known component by name', () => {
    expect(latestVersionFor(components, 'dig-node')).toBe('0.31.1');
  });

  it('returns null for a component the manifest does not carry', () => {
    expect(latestVersionFor(components, 'dig-relay')).toBeNull();
  });
});

describe('fetchFeedComponents', () => {
  it('fetches the live feed URL and parses the component list', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(UPDATE_FEED_MANIFEST_URL);
      return { ok: true, json: async () => SIGNED_MANIFEST } as Response;
    }) as typeof fetch;
    const components = await fetchFeedComponents(fetchImpl);
    expect(latestVersionFor(components, 'dig-node')).toBe('0.31.1');
  });

  it('throws FeedManifestUnavailableError on a non-2xx response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
    await expect(fetchFeedComponents(fetchImpl)).rejects.toBeInstanceOf(FeedManifestUnavailableError);
  });

  it('throws FeedManifestUnavailableError on a network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(fetchFeedComponents(fetchImpl)).rejects.toBeInstanceOf(FeedManifestUnavailableError);
  });

  it('throws FeedManifestUnavailableError on unparsable JSON', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    })) as unknown as typeof fetch;
    await expect(fetchFeedComponents(fetchImpl)).rejects.toBeInstanceOf(FeedManifestUnavailableError);
  });
});
