import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchNftMetadataJson } from '@/background/nft-metadata';

// Mocks `global.fetch` so no network is touched. Each test wires the exact Response/rejection the
// SUT branches on. Load-bearing: the codes + the exact success shape (`{ metadata }`, NOT
// `{ success: true, metadata }`) are asserted, so a lazier reshape would fail.

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl as () => Promise<Response>));
}

describe('fetchNftMetadataJson (#98)', () => {
  it('rejects a non-string uri as BAD_REQUEST without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchNftMetadataJson(undefined)).toEqual({
      success: false,
      code: 'BAD_REQUEST',
      message: 'metadata uri must be http(s)',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) uri as BAD_REQUEST', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchNftMetadataJson('ipfs://Qm...')).toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the RAW decoded JSON under `metadata` on success (exact shape)', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => '{"name":"DIG #1","attributes":[]}' }));
    expect(await fetchNftMetadataJson('https://cdn.example/meta.json')).toEqual({
      metadata: { name: 'DIG #1', attributes: [] },
    });
  });

  it('maps a non-ok response to FETCH_FAILED with the HTTP status', async () => {
    mockFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
    expect(await fetchNftMetadataJson('https://cdn.example/missing.json')).toEqual({
      success: false,
      code: 'FETCH_FAILED',
      message: 'HTTP 404',
    });
  });

  it('rejects an oversized document as TOO_LARGE before parsing', async () => {
    const huge = 'x'.repeat(200 * 1024 + 1);
    const textSpy = vi.fn(async () => huge);
    mockFetch(async () => ({ ok: true, status: 200, text: textSpy }));
    expect(await fetchNftMetadataJson('https://cdn.example/big.json')).toMatchObject({ code: 'TOO_LARGE' });
  });

  it('maps unparseable content to INVALID_JSON', async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => 'not json <html>' }));
    expect(await fetchNftMetadataJson('https://cdn.example/page.html')).toMatchObject({ code: 'INVALID_JSON' });
  });

  it('classifies an AbortError (timeout) by NAME as TIMEOUT — not NETWORK_ERROR', async () => {
    // An aborted fetch rejects with a DOMException named 'AbortError' that may not be `instanceof
    // Error`; the SUT must detect it by name. Simulate that exact shape.
    const abort = Object.assign(Object.create(null), { name: 'AbortError', message: 'aborted' });
    mockFetch(async () => {
      throw abort;
    });
    expect(await fetchNftMetadataJson('https://slow.example/meta.json')).toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps a generic fetch rejection to NETWORK_ERROR with the message', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchNftMetadataJson('https://blocked.example/meta.json')).toEqual({
      success: false,
      code: 'NETWORK_ERROR',
      message: 'Failed to fetch',
    });
  });
});
