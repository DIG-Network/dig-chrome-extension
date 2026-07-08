import { describe, it, expect, vi } from 'vitest';
import { extractDexieOfferId, postOfferToDexie, fetchDexieOffer, searchDexieOffers, type DexieFetch } from '@/lib/dexie';

/** A minimal fetch-shaped stub returning a canned JSON body. */
function fetchReturning(body: unknown, ok = true): DexieFetch {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });
}

describe('dexie (#102 — dexie.space marketplace integration)', () => {
  describe('extractDexieOfferId', () => {
    it('extracts the id from a dexie.space offer URL', () => {
      expect(extractDexieOfferId('https://dexie.space/offers/HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa')).toBe(
        'HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa',
      );
    });

    it('accepts a bare dexie id (not prefixed with offer1)', () => {
      expect(extractDexieOfferId('HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa')).toBe('HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa');
    });

    it('trims surrounding whitespace', () => {
      expect(extractDexieOfferId('  HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa  ')).toBe('HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa');
    });

    it('returns null for a raw offer1… string (not a dexie link/id)', () => {
      expect(extractDexieOfferId('offer1qqqexampleofferstringqqq')).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(extractDexieOfferId('not a link or id!! ###')).toBeNull();
      expect(extractDexieOfferId('')).toBeNull();
    });
  });

  describe('postOfferToDexie', () => {
    it('posts the offer bytes and returns the dexie id', async () => {
      const fetchFn = fetchReturning({ success: true, id: 'newDexieId123', known: false });
      const res = await postOfferToDexie(fetchFn, 'offer1qqqrealofferqqq');
      expect(res).toEqual({ id: 'newDexieId123', known: false });
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.dexie.space/v1/offers',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ offer: 'offer1qqqrealofferqqq' }) }),
      );
    });

    it('reports `known:true` when dexie already indexed this exact offer', async () => {
      const fetchFn = fetchReturning({ success: true, id: 'existingId', known: true });
      const res = await postOfferToDexie(fetchFn, 'offer1qqqrealofferqqq');
      expect(res.known).toBe(true);
    });

    it('throws DEXIE_POST_FAILED with dexie\'s own error message on rejection', async () => {
      const fetchFn = fetchReturning({ success: false, error_message: 'Invalid Offer' });
      await expect(postOfferToDexie(fetchFn, 'not-a-real-offer')).rejects.toThrow(/DEXIE_POST_FAILED.*Invalid Offer/);
    });

    it('throws DEXIE_POST_FAILED on a non-JSON / network-level failure', async () => {
      const fetchFn: DexieFetch = vi.fn().mockRejectedValue(new Error('network down'));
      await expect(postOfferToDexie(fetchFn, 'offer1qqq')).rejects.toThrow(/DEXIE_POST_FAILED/);
    });
  });

  describe('fetchDexieOffer', () => {
    const RAW = {
      id: 'HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa',
      status: 0,
      offer: 'offer1qqqrealbytesqqq',
      date_found: '2026-07-08T21:36:11.693Z',
      offered: [{ id: 'aa'.repeat(32), code: 'wUSDC.b', name: 'Base warp.green USDC', amount: 50 }],
      requested: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 33.955 }],
    };

    it('resolves an id/url to the offer summary', async () => {
      const fetchFn = fetchReturning({ success: true, offer: RAW });
      const res = await fetchDexieOffer(fetchFn, 'https://dexie.space/offers/HuorAxfhfB9mvaTN7d1qAMohLjTaQ8P6ZisJiEhxtNwa');
      expect(res).toEqual({
        id: RAW.id,
        offerStr: 'offer1qqqrealbytesqqq',
        status: 0,
        dateFound: RAW.date_found,
        offered: [{ id: 'aa'.repeat(32), code: 'wUSDC.b', name: 'Base warp.green USDC', amount: 50 }],
        requested: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 33.955 }],
      });
      expect(fetchFn).toHaveBeenCalledWith(`https://api.dexie.space/v1/offers/${RAW.id}`);
    });

    it('returns null for input that is not a dexie link/id (e.g. a raw offer string)', async () => {
      const fetchFn: DexieFetch = vi.fn();
      expect(await fetchDexieOffer(fetchFn, 'offer1qqqexampleofferstringqqq')).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null when dexie has no record of the id (success:false)', async () => {
      const fetchFn = fetchReturning({ success: false });
      expect(await fetchDexieOffer(fetchFn, 'unknownId123')).toBeNull();
    });

    it('returns null on a network failure rather than throwing', async () => {
      const fetchFn: DexieFetch = vi.fn().mockRejectedValue(new Error('network down'));
      expect(await fetchDexieOffer(fetchFn, 'anyId')).toBeNull();
    });
  });

  describe('searchDexieOffers', () => {
    it('returns the mapped offer summaries for an OPEN-offers search', async () => {
      const fetchFn = fetchReturning({
        success: true,
        count: 1,
        page: 1,
        page_size: 20,
        offers: [
          {
            id: 'o1',
            status: 0,
            offer: 'offer1qqqbrowsedqqq',
            date_found: '2026-07-08T00:00:00.000Z',
            offered: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 1.5 }],
            requested: [{ id: 'bb'.repeat(32), code: 'DIG', name: 'DIG', amount: 100 }],
          },
        ],
      });
      const res = await searchDexieOffers(fetchFn);
      expect(res).toEqual([
        {
          id: 'o1',
          offerStr: 'offer1qqqbrowsedqqq',
          status: 0,
          dateFound: '2026-07-08T00:00:00.000Z',
          offered: [{ id: 'xch', code: 'XCH', name: 'Chia', amount: 1.5 }],
          requested: [{ id: 'bb'.repeat(32), code: 'DIG', name: 'DIG', amount: 100 }],
        },
      ]);
      const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('https://api.dexie.space/v1/offers?');
      expect(url).toContain('status=0');
    });

    it('includes offered/requested asset filters as query params when given', async () => {
      const fetchFn = fetchReturning({ success: true, offers: [] });
      await searchDexieOffers(fetchFn, { offered: 'xch', requested: 'DIG' });
      const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('offered=xch');
      expect(url).toContain('requested=DIG');
    });

    it('returns [] on a failed/malformed response rather than throwing', async () => {
      expect(await searchDexieOffers(fetchReturning({ success: false }))).toEqual([]);
      expect(await searchDexieOffers(fetchReturning({ success: true, offers: 'not-an-array' }))).toEqual([]);
    });

    it('returns [] on a network failure rather than throwing', async () => {
      const fetchFn: DexieFetch = vi.fn().mockRejectedValue(new Error('network down'));
      expect(await searchDexieOffers(fetchFn)).toEqual([]);
    });
  });
});
