import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pure lib client — this suite tests only the SW-facing glue (validation, response shapes,
// error-code extraction), not the dexie HTTP client (which has its own src/lib/dexie.test.ts).
const { postOfferToDexie, fetchDexieOffer, searchDexieOffers } = vi.hoisted(() => ({
  postOfferToDexie: vi.fn(),
  fetchDexieOffer: vi.fn(),
  searchDexieOffers: vi.fn(),
}));
vi.mock('@/lib/dexie', () => ({ postOfferToDexie, fetchDexieOffer, searchDexieOffers }));

const { handleDexiePost, handleDexieBrowse, handleDexieResolve } = await import('@/background/dexie-handlers');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleDexiePost (#102)', () => {
  it('rejects a non-offer1 string as BAD_REQUEST without calling the client', async () => {
    expect(await handleDexiePost('not-an-offer')).toEqual({
      success: false,
      code: 'BAD_REQUEST',
      message: 'offer string required',
    });
    expect(await handleDexiePost(42)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(postOfferToDexie).not.toHaveBeenCalled();
  });

  it('returns { success, dexieId, known } on a successful post (exact shape)', async () => {
    postOfferToDexie.mockResolvedValueOnce({ id: 'DEX123', known: true });
    expect(await handleDexiePost('offer1abc')).toEqual({ success: true, dexieId: 'DEX123', known: true });
    expect(postOfferToDexie).toHaveBeenCalledWith(fetch, 'offer1abc');
  });

  it('extracts the leading CODE: prefix from a client error as `code`', async () => {
    postOfferToDexie.mockRejectedValueOnce(new Error('RATE_LIMITED: slow down'));
    expect(await handleDexiePost('offer1abc')).toEqual({
      success: false,
      code: 'RATE_LIMITED',
      message: 'RATE_LIMITED: slow down',
    });
  });

  it('falls back to DEXIE_POST_FAILED when the error has no CODE: prefix', async () => {
    postOfferToDexie.mockRejectedValueOnce(new Error('network exploded'));
    expect(await handleDexiePost('offer1abc')).toEqual({
      success: false,
      code: 'DEXIE_POST_FAILED',
      message: 'network exploded',
    });
  });
});

describe('handleDexieBrowse (#102)', () => {
  it('forwards offered/requested filters and returns { offers }', async () => {
    const offers = [{ id: 'a' }, { id: 'b' }];
    searchDexieOffers.mockResolvedValueOnce(offers);
    expect(await handleDexieBrowse('xch', 'DBX')).toEqual({ offers });
    expect(searchDexieOffers).toHaveBeenCalledWith(fetch, { offered: 'xch', requested: 'DBX' });
  });

  it('omits absent filters (no offered/requested → empty params)', async () => {
    searchDexieOffers.mockResolvedValueOnce([]);
    expect(await handleDexieBrowse()).toEqual({ offers: [] });
    expect(searchDexieOffers).toHaveBeenCalledWith(fetch, {});
  });
});

describe('handleDexieResolve (#102)', () => {
  it('rejects an empty/non-string idOrUrl as BAD_REQUEST without calling the client', async () => {
    expect(await handleDexieResolve('')).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await handleDexieResolve(undefined)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchDexieOffer).not.toHaveBeenCalled();
  });

  it('returns { offer } (the resolved summary or null)', async () => {
    const offer = { id: 'DEX9', status: 0 };
    fetchDexieOffer.mockResolvedValueOnce(offer);
    expect(await handleDexieResolve('DEX9')).toEqual({ offer });
    expect(fetchDexieOffer).toHaveBeenCalledWith(fetch, 'DEX9');

    fetchDexieOffer.mockResolvedValueOnce(null);
    expect(await handleDexieResolve('missing')).toEqual({ offer: null });
  });
});
