import { describe, it, expect, vi } from 'vitest';
import { makeNodeWalletClient, transactionToEntries } from '@/lib/node-wallet';

/** A scripted `fetch`: maps `POST {base}/{method}` → a canned JSON body (Sage v0.12.11 shapes). */
function fakeFetch(routes: Record<string, unknown>, opts: { status?: number; body?: string } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const method = url.split('/').pop() as string;
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, text: async () => opts.body ?? 'boom' } as unknown as Response;
    }
    if (!(method in routes)) {
      return { ok: false, status: 404, text: async () => `no route ${method}` } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => routes[method] } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('makeNodeWalletClient — request wiring', () => {
  it('POSTs snake_case methods to {base}/{method} with a JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch({ get_sync_status: { synced_coins: 5, total_coins: 5, selectable_balance: 42 } });
    const client = makeNodeWalletClient('http://localhost:9778/', { fetch: fetchImpl });
    await client.getSyncStatus();
    expect(calls[0].url).toBe('http://localhost:9778/get_sync_status');
    expect(calls[0].body).toEqual({});
  });

  it('throws (surfacing the text body) on a non-2xx response', async () => {
    const { fetchImpl } = fakeFetch({}, { status: 500, body: 'wallet error' });
    const client = makeNodeWalletClient('http://localhost:9778', { fetch: fetchImpl });
    await expect(client.getSyncStatus()).rejects.toThrow(/get_sync_status failed \(500\).*wallet error/);
  });
});

describe('makeNodeWalletClient — injected socket transport (#372)', () => {
  it('routes reads over sendRequest (the /ws socket) instead of HTTP, sharing the mappers', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const sendRequest = async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'get_sync_status') return { synced_coins: 3, total_coins: 3, selectable_balance: 99 };
      if (method === 'get_cats') return { cats: [{ asset_id: '0xAA', balance: 7 }] };
      return {};
    };
    const client = makeNodeWalletClient('http://localhost:9778', { fetch: fetchImpl, sendRequest });

    // Same mapper output as the HTTP path — but no fetch happened.
    expect(await client.getBalances()).toEqual({ xch: 99, cats: { aa: 7 } });
    expect(calls).toHaveLength(0);
    expect(sent.map((s) => s.method).sort()).toEqual(['get_cats', 'get_sync_status']);
  });

  it('propagates a rejected socket request so the SW can fall back to HTTP', async () => {
    const { fetchImpl } = fakeFetch({});
    const sendRequest = async () => {
      throw new Error('wallet ws not connected');
    };
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl, sendRequest });
    await expect(client.getSyncStatus()).rejects.toThrow(/not connected/);
  });
});

describe('defensive parsing (missing / non-finite / empty)', () => {
  it('defaults missing sync-status fields to 0 / synced', async () => {
    const { fetchImpl } = fakeFetch({ get_sync_status: {} });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect(await client.getSyncStatus()).toEqual({ syncedCoins: 0, totalCoins: 0, synced: true, selectableXch: 0 });
  });

  it('treats a non-finite Amount as 0 (number) / "0" (string)', async () => {
    const { fetchImpl } = fakeFetch({
      get_sync_status: { selectable_balance: 'not-a-number' },
      get_cats: { cats: [{ asset_id: 'aa', balance: 'NaN' }] },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect(await client.getBalances()).toEqual({ xch: 0, cats: { aa: 0 } });
  });

  it('returns empty lists when the node omits the arrays entirely', async () => {
    const { fetchImpl } = fakeFetch({ get_nfts: {}, get_dids: {}, get_coins: {}, get_transactions: {} });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect((await client.getNfts()).nfts).toEqual([]);
    expect((await client.getDids()).dids).toEqual([]);
    expect((await client.getCoins()).coins).toEqual([]);
    expect((await client.getActivity()).events).toEqual([]);
  });

  it('defaults a coin with no amount to "0"', async () => {
    const { fetchImpl } = fakeFetch({ get_coins: { coins: [{ coin_id: 'c' }] } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect((await client.getCoins()).coins[0]).toEqual({ coinId: 'c', amount: '0', confirmedHeight: 0 });
  });
});

describe('getSyncStatus', () => {
  it('derives synced + selectable XCH', async () => {
    const { fetchImpl } = fakeFetch({ get_sync_status: { synced_coins: 3, total_coins: 4, selectable_balance: '1000000000000' } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect(await client.getSyncStatus()).toEqual({
      syncedCoins: 3,
      totalCoins: 4,
      synced: false,
      selectableXch: 1_000_000_000_000,
    });
  });

  it('treats zero total coins as synced (fresh wallet)', async () => {
    const { fetchImpl } = fakeFetch({ get_sync_status: { synced_coins: 0, total_coins: 0, selectable_balance: 0 } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect((await client.getSyncStatus()).synced).toBe(true);
  });
});

describe('getBalances', () => {
  it('maps XCH (selectable) + per-CAT balances keyed by stripped asset id', async () => {
    const { fetchImpl } = fakeFetch({
      get_sync_status: { selectable_balance: 1_500_000_000_000 },
      get_cats: {
        cats: [
          { asset_id: '0xABCDEF', balance: 12345 },
          { asset_id: 'fedcba', balance: '9' },
          { asset_id: null, balance: 5 }, // no asset id → skipped
        ],
      },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    expect(await client.getBalances()).toEqual({
      xch: 1_500_000_000_000,
      cats: { abcdef: 12345, fedcba: 9 },
    });
  });
});

describe('getNfts', () => {
  it('maps a Sage NftRecord to the vault WalletNft shape', async () => {
    const { fetchImpl, calls } = fakeFetch({
      get_nfts: {
        nfts: [
          {
            launcher_id: '0xLAUNCH',
            coin_id: '0xCOIN',
            owner_did: '0xDID',
            royalty_ten_thousandths: 250,
            royalty_address: '0xROYAL',
            data_uris: ['https://a'],
            data_hash: '0xDATA',
            metadata_uris: ['https://m'],
            metadata_hash: null,
            license_uris: [],
            edition_number: 2,
            edition_total: 10,
          },
        ],
        total: 1,
      },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { nfts } = await client.getNfts();
    expect(calls[0].body).toEqual({ offset: 0, limit: 1000, include_hidden: false });
    expect(nfts[0]).toEqual({
      launcherId: 'launch',
      coinId: 'coin',
      p2PuzzleHash: '',
      collectionId: 'did',
      editionNumber: '2',
      editionTotal: '10',
      royaltyBasisPoints: 250,
      royaltyPuzzleHash: 'royal',
      dataUris: ['https://a'],
      dataHash: 'data',
      metadataUris: ['https://m'],
      metadataHash: null,
      licenseUris: [],
    });
  });

  it('defaults edition + uris + hashes when absent', async () => {
    const { fetchImpl } = fakeFetch({ get_nfts: { nfts: [{ launcher_id: 'l', coin_id: 'c' }] } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { nfts } = await client.getNfts();
    expect(nfts[0]).toMatchObject({
      collectionId: null,
      editionNumber: '1',
      editionTotal: '1',
      royaltyBasisPoints: 0,
      dataUris: [],
      dataHash: null,
      metadataUris: [],
      metadataHash: null,
      licenseUris: [],
    });
  });
});

describe('getDids', () => {
  it('maps a Sage DidRecord to the vault WalletDid shape', async () => {
    const { fetchImpl } = fakeFetch({
      get_dids: { dids: [{ launcher_id: '0xL', coin_id: '0xC', name: 'Alice', recovery_hash: '0xRH' }] },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { dids } = await client.getDids();
    expect(dids[0]).toEqual({
      launcherId: 'l',
      coinId: 'c',
      p2PuzzleHash: '',
      recoveryListHash: 'rh',
      numVerificationsRequired: '1',
      profileName: 'Alice',
    });
  });

  it('coerces a blank/absent name to null profileName', async () => {
    const { fetchImpl } = fakeFetch({ get_dids: { dids: [{ launcher_id: 'l', coin_id: 'c', name: '' }] } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { dids } = await client.getDids();
    expect(dids[0].profileName).toBeNull();
    expect(dids[0].recoveryListHash).toBeNull();
  });
});

describe('getCoins', () => {
  it('maps coins + includes asset_id in the body when given', async () => {
    const { fetchImpl, calls } = fakeFetch({
      get_coins: { coins: [{ coin_id: '0xC1', amount: '18446744073709551616', created_height: 100 }] },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { coins } = await client.getCoins('deadbeef');
    expect(calls[0].body).toMatchObject({ asset_id: 'deadbeef', filter_mode: 'unspent', sort_mode: 'amount' });
    expect(coins[0]).toEqual({ coinId: 'c1', amount: '18446744073709551616', confirmedHeight: 100 });
  });

  it('omits asset_id for the native XCH coin list; defaults height to 0', async () => {
    const { fetchImpl, calls } = fakeFetch({ get_coins: { coins: [{ coin_id: 'c', amount: 7 }] } });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { coins } = await client.getCoins();
    expect('asset_id' in (calls[0].body as object)).toBe(false);
    expect(coins[0]).toEqual({ coinId: 'c', amount: '7', confirmedHeight: 0 });
  });
});

describe('getActivity / transactionToEntries', () => {
  it('classifies a net-positive own flow as received, negative as sent', () => {
    // Sent 1 XCH out (spent 2 own, created 1 own change + 1 external), net own = -1.
    const sent = transactionToEntries({
      height: 500,
      timestamp: 1_700_000_000,
      spent: [{ coin_id: 'a', amount: 2_000_000_000_000, address_kind: 'own', asset: { asset_id: null } }],
      created: [
        { coin_id: 'b', amount: 1_000_000_000_000, address_kind: 'own', asset: { asset_id: null } },
        { coin_id: 'c', amount: 1_000_000_000_000, address_kind: 'external', asset: { asset_id: null } },
      ],
    });
    expect(sent).toEqual([
      {
        id: 'node:500:XCH',
        kind: 'sent',
        asset: 'XCH',
        amount: '1000000000000',
        counterparty: null,
        coinId: 'a',
        timestamp: 1_700_000_000_000,
        status: 'confirmed',
      },
    ]);

    const received = transactionToEntries({
      height: 600,
      timestamp: 1_700_000_100,
      created: [{ coin_id: 'x', amount: 500, address_kind: 'own', asset: { asset_id: '0xTAIL' } }],
    });
    expect(received[0]).toMatchObject({ kind: 'received', asset: 'tail', amount: '500', status: 'confirmed', coinId: 'x' });
  });

  it('skips a net-zero (self-transfer / fee-only) transaction', () => {
    const entries = transactionToEntries({
      height: 700,
      timestamp: 1,
      spent: [{ coin_id: 'a', amount: 100, address_kind: 'own', asset: { asset_id: null } }],
      created: [{ coin_id: 'b', amount: 100, address_kind: 'own', asset: { asset_id: null } }],
    });
    expect(entries).toEqual([]);
  });

  it('ignores transactions with no own legs (all external)', () => {
    expect(
      transactionToEntries({
        height: 1,
        timestamp: 1,
        created: [{ coin_id: 'z', amount: 10, address_kind: 'external', asset: { asset_id: null } }],
      }),
    ).toEqual([]);
  });

  it('getActivity flattens transactions in order', async () => {
    const { fetchImpl, calls } = fakeFetch({
      get_transactions: {
        transactions: [
          { height: 2, timestamp: 2, created: [{ coin_id: 'x', amount: 5, address_kind: 'own', asset: { asset_id: null } }] },
          { height: 1, timestamp: 1, spent: [{ coin_id: 'y', amount: 5, address_kind: 'own', asset: { asset_id: null } }] },
        ],
      },
    });
    const client = makeNodeWalletClient('http://n', { fetch: fetchImpl });
    const { events } = await client.getActivity();
    expect(calls[0].body).toEqual({ offset: 0, limit: 1000, ascending: false });
    expect(events.map((e) => e.kind)).toEqual(['received', 'sent']);
  });
});
