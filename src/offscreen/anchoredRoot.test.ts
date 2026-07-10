import { describe, it, expect, beforeAll } from 'vitest';
import {
  walkAnchoredRoot,
  makeFetchLineageClient,
  lineageCoinId,
  type LineageCoinsetClient,
  type LineageCoinSpend,
  type Chip35Wasm,
} from './anchoredRoot';
import { loadChip35WasmNode } from '@/test/chip35Wasm';

// Real mainnet fixture captured from api.coinset.org for the SAME store the e2e live-node suite
// uses (e2e/sw/live-node-content-load.spec.ts: STORE_ID / ANCHORED_ROOT) — a launcher spend (the
// eve store) followed by ONE commit spend, then the live unspent tip. Captured once so the test is
// hermetic (no live network in CI) while still proving the walk against REAL chain bytes, not a
// hand-rolled fake — independently cross-checked against the anchored root the live-node e2e suite
// already asserts via `dig.getAnchoredRoot` (#226), proving this coinset-direct walk (#228) resolves
// the IDENTICAL root.
const STORE_ID = 'ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812';
const ANCHORED_ROOT = '9e26ff2500930604278dd013c986a3d3ace2565c69e13583e8575c70319bd98b';
const EVE_COIN_ID = '1cbbd55f00087199a0cc5005bdd02809f6f4fb0aa5b238f7423227b1e110f49e';
const TIP_COIN_ID = '5edaa1ea429ca78ae416b482e6ef0c5eaf973497dec2d4c8f199be38a3a27155';

const LAUNCHER_PUZZLE_REVEAL =
  'ff02ffff01ff04ffff04ff04ffff04ff05ffff04ff0bff80808080ffff04ffff04ff0affff04ffff02ff0effff04ff02ffff04ffff04ff05ffff04ff0bffff04ff17ff80808080ff80808080ff808080ff808080ffff04ffff01ff33ff3cff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff0effff04ff02ffff04ff09ff80808080ffff02ff0effff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080';
const LAUNCHER_SOLUTION =
  'ffa03658364aae249138165a5e1e5ad1b6ce0fbab48e414d4391d7ab2a88b3da6ec5ff01ffffffa0000000000000000000000000000000000000000000000000000000000000000080ffa0bac5d2abe215ba65a2628965f4905260cab94c23bc8da1727fe662e9bdfa0a328080';
const COMMIT_PUZZLE_REVEAL =
  'ff02ffff01ff02ffff01ff02ffff03ffff18ff2fff3480ffff01ff04ffff04ff20ffff04ff2fff808080ffff04ffff02ff3effff04ff02ffff04ff05ffff04ffff02ff2affff04ff02ffff04ff27ffff04ffff02ffff03ff77ffff01ff02ff36ffff04ff02ffff04ff09ffff04ff57ffff04ffff02ff2effff04ff02ffff04ff05ff80808080ff808080808080ffff011d80ff0180ffff04ffff02ffff03ff77ffff0181b7ffff015780ff0180ff808080808080ffff04ff77ff808080808080ffff02ff3affff04ff02ffff04ff05ffff04ffff02ff0bff5f80ffff01ff8080808080808080ffff01ff088080ff0180ffff04ffff01ffffffff4947ff0233ffff0401ff0102ffffff20ff02ffff03ff05ffff01ff02ff32ffff04ff02ffff04ff0dffff04ffff0bff3cffff0bff34ff2480ffff0bff3cffff0bff3cffff0bff34ff2c80ff0980ffff0bff3cff0bffff0bff34ff8080808080ff8080808080ffff010b80ff0180ffff02ffff03ffff22ffff09ffff0dff0580ff2280ffff09ffff0dff0b80ff2280ffff15ff17ffff0181ff8080ffff01ff0bff05ff0bff1780ffff01ff088080ff0180ff02ffff03ff0bffff01ff02ffff03ffff02ff26ffff04ff02ffff04ff13ff80808080ffff01ff02ffff03ffff20ff1780ffff01ff02ffff03ffff09ff81b3ffff01818f80ffff01ff02ff3affff04ff02ffff04ff05ffff04ff1bffff04ff34ff808080808080ffff01ff04ffff04ff23ffff04ffff02ff36ffff04ff02ffff04ff09ffff04ff53ffff04ffff02ff2effff04ff02ffff04ff05ff80808080ff808080808080ff738080ffff02ff3affff04ff02ffff04ff05ffff04ff1bffff04ff34ff8080808080808080ff0180ffff01ff088080ff0180ffff01ff04ff13ffff02ff3affff04ff02ffff04ff05ffff04ff1bffff04ff17ff8080808080808080ff0180ffff01ff02ffff03ff17ff80ffff01ff088080ff018080ff0180ffffff02ffff03ffff09ff09ff3880ffff01ff02ffff03ffff18ff2dffff010180ffff01ff0101ff8080ff0180ff8080ff0180ff0bff3cffff0bff34ff2880ffff0bff3cffff0bff3cffff0bff34ff2c80ff0580ffff0bff3cffff02ff32ffff04ff02ffff04ff07ffff04ffff0bff34ff3480ff8080808080ffff0bff34ff8080808080ffff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff2effff04ff02ffff04ff09ff80808080ffff02ff2effff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff02ffff03ffff21ff17ffff09ff0bff158080ffff01ff04ff30ffff04ff0bff808080ffff01ff088080ff0180ff018080ffff04ffff01ffa07faa3253bfddd1e0decb0906b2dc6247bbc4cf608f58345d173adb63e8b47c9fffa0ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812a0eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9ffff04ffff01ff02ffff01ff02ffff01ff02ff3effff04ff02ffff04ff05ffff04ffff02ff2fff5f80ffff04ff80ffff04ffff04ffff04ff0bffff04ff17ff808080ffff01ff808080ffff01ff8080808080808080ffff04ffff01ffffff0233ff04ff0101ffff02ff02ffff03ff05ffff01ff02ff1affff04ff02ffff04ff0dffff04ffff0bff12ffff0bff2cff1480ffff0bff12ffff0bff12ffff0bff2cff3c80ff0980ffff0bff12ff0bffff0bff2cff8080808080ff8080808080ffff010b80ff0180ffff0bff12ffff0bff2cff1080ffff0bff12ffff0bff12ffff0bff2cff3c80ff0580ffff0bff12ffff02ff1affff04ff02ffff04ff07ffff04ffff0bff2cff2c80ff8080808080ffff0bff2cff8080808080ffff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff2effff04ff02ffff04ff09ff80808080ffff02ff2effff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff02ffff03ff0bffff01ff02ffff03ffff09ff23ff1880ffff01ff02ffff03ffff18ff81b3ff2c80ffff01ff02ffff03ffff20ff1780ffff01ff02ff3effff04ff02ffff04ff05ffff04ff1bffff04ff33ffff04ff2fffff04ff5fff8080808080808080ffff01ff088080ff0180ffff01ff04ff13ffff02ff3effff04ff02ffff04ff05ffff04ff1bffff04ff17ffff04ff2fffff04ff5fff80808080808080808080ff0180ffff01ff02ffff03ffff09ff23ffff0181e880ffff01ff02ff3effff04ff02ffff04ff05ffff04ff1bffff04ff17ffff04ffff02ffff03ffff22ffff09ffff02ff2effff04ff02ffff04ff53ff80808080ff82014f80ffff20ff5f8080ffff01ff02ff53ffff04ff818fffff04ff82014fffff04ff81b3ff8080808080ffff01ff088080ff0180ffff04ff2cff8080808080808080ffff01ff04ff13ffff02ff3effff04ff02ffff04ff05ffff04ff1bffff04ff17ffff04ff2fffff04ff5fff80808080808080808080ff018080ff0180ffff01ff04ffff04ff18ffff04ffff02ff16ffff04ff02ffff04ff05ffff04ff27ffff04ffff0bff2cff82014f80ffff04ffff02ff2effff04ff02ffff04ff818fff80808080ffff04ffff0bff2cff0580ff8080808080808080ff378080ff81af8080ff0180ff018080ffff04ffff01a0a04d9f57764f54a43e4030befb4d80026e870519aaa66334aef8304f5d0393c2ffff04ffff01ffa0000000000000000000000000000000000000000000000000000000000000000080ffff04ffff01a057bfd1cb0adda3d94315053fda723f2028320faa8338225d99f629e3d46d43a9ffff04ffff01ff02ffff01ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080ffff04ffff01b082a042f2a57c2863862a061700d9cf2650adede6f90aff662a73ed31c47f60511ac9dc4b8f276477c606ba9272a43de9ff018080ff018080808080ff01808080';
const COMMIT_SOLUTION =
  'ffffa03d8361caba83212b273428a300ffdb87d439e8c86d37067e79e2bbe2cfa0f904ff0180ff01ffffff80ffff01ffff81e8ff0bffffffffa09e26ff2500930604278dd013c986a3d3ace2565c69e13583e8575c70319bd98b80ffa057bfd1cb0adda3d94315053fda723f2028320faa8338225d99f629e3d46d43a980ff808080ffff33ffa0bac5d2abe215ba65a2628965f4905260cab94c23bc8da1727fe662e9bdfa0a32ff01ffffa0ab554db9c62e8dc2185914741e06539bacdcc3670762417a5f644b84fd382812808080ff80808080';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A fake coinset client driven entirely from the captured fixture above (no network). */
function fixtureClient(): LineageCoinsetClient {
  const records: Record<string, { spent: boolean; spentHeight: number }> = {
    [STORE_ID]: { spent: true, spentHeight: 8882302 },
    [EVE_COIN_ID]: { spent: true, spentHeight: 8882305 },
    [TIP_COIN_ID]: { spent: false, spentHeight: 0 },
  };
  const spends: Record<string, LineageCoinSpend> = {
    [STORE_ID]: {
      coin: {
        parentCoinInfo: hexToBytes('3d8361caba83212b273428a300ffdb87d439e8c86d37067e79e2bbe2cfa0f904'),
        puzzleHash: hexToBytes('eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9'),
        amount: 1n,
      },
      puzzleReveal: hexToBytes(LAUNCHER_PUZZLE_REVEAL),
      solution: hexToBytes(LAUNCHER_SOLUTION),
    },
    [EVE_COIN_ID]: {
      coin: {
        parentCoinInfo: hexToBytes(STORE_ID),
        puzzleHash: hexToBytes('3658364aae249138165a5e1e5ad1b6ce0fbab48e414d4391d7ab2a88b3da6ec5'),
        amount: 1n,
      },
      puzzleReveal: hexToBytes(COMMIT_PUZZLE_REVEAL),
      solution: hexToBytes(COMMIT_SOLUTION),
    },
  };
  return {
    async getCoinRecord(coinIdHex) {
      return records[coinIdHex] ?? null;
    },
    async getCoinSpend(coinIdHex, _height) {
      return spends[coinIdHex] ?? null;
    },
  };
}

let chip35: Chip35Wasm;
beforeAll(async () => {
  chip35 = await loadChip35WasmNode();
});

describe('walkAnchoredRoot (#228 — coinset-direct chain-anchored-root walk)', () => {
  it('resolves the REAL chain-anchored root over real captured mainnet spend bytes (matches the node-resolved root asserted by e2e #226)', async () => {
    const root = await walkAnchoredRoot(fixtureClient(), chip35, STORE_ID);
    expect(root).toBe(ANCHORED_ROOT);
  });

  it('accepts an 0x-prefixed / mixed-case store id', async () => {
    const root = await walkAnchoredRoot(fixtureClient(), chip35, `0x${STORE_ID.toUpperCase()}`);
    expect(root).toBe(ANCHORED_ROOT);
  });

  it('fails closed (null) when the launcher is not on chain', async () => {
    const client: LineageCoinsetClient = { async getCoinRecord() { return null; }, async getCoinSpend() { return null; } };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID)).toBeNull();
  });

  it('fails closed (null) when the launcher is not yet spent (store minted but never committed)', async () => {
    const client: LineageCoinsetClient = {
      async getCoinRecord() { return { spent: false, spentHeight: 0 }; },
      async getCoinSpend() { return null; },
    };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID)).toBeNull();
  });

  it('fails closed (null) when the launcher spend cannot be fetched', async () => {
    const client: LineageCoinsetClient = {
      async getCoinRecord() { return { spent: true, spentHeight: 8882302 }; },
      async getCoinSpend() { return null; },
    };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID)).toBeNull();
  });

  it('fails closed (null) when a mid-lineage coin record is unresolvable (coinset hiccup)', async () => {
    const base = fixtureClient();
    const client: LineageCoinsetClient = {
      getCoinSpend: base.getCoinSpend,
      async getCoinRecord(id) {
        if (id === EVE_COIN_ID) return null; // simulate the hiccup at the eve generation
        return base.getCoinRecord(id);
      },
    };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID)).toBeNull();
  });

  it('fails closed (null) when dataStoreFromSpend cannot parse a spend (e.g. a melt)', async () => {
    const base = fixtureClient();
    const client: LineageCoinsetClient = {
      getCoinRecord: base.getCoinRecord,
      async getCoinSpend(id, height) {
        if (id === EVE_COIN_ID) return { coin: (await base.getCoinSpend(id, height))!.coin, puzzleReveal: new Uint8Array([0xff]), solution: new Uint8Array([0xff]) };
        return base.getCoinSpend(id, height);
      },
    };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID)).toBeNull();
  });

  it('fails closed (null) when the lineage exceeds maxDepth without reaching a live tip', async () => {
    // A store record that always reports spent, forever — the walk must bail rather than spin or
    // return a stale/guessed root.
    const client: LineageCoinsetClient = {
      async getCoinRecord() { return { spent: true, spentHeight: 8882302 }; },
      async getCoinSpend() {
        // Always returns a well-formed spend for the SAME store — dataStoreFromSpend keeps
        // succeeding (never throws), so only the depth bound stops the loop.
        return fixtureClient().getCoinSpend(STORE_ID, 8882302);
      },
    };
    expect(await walkAnchoredRoot(client, chip35, STORE_ID, 3)).toBeNull();
  });

  it('a fake chip35 that throws on the eve spend fails closed', async () => {
    const base = fixtureClient();
    const throwing: Chip35Wasm = {
      dataStoreFromSpend() {
        throw new Error('DRIVER_ERROR: unparsable');
      },
    };
    expect(await walkAnchoredRoot(base, throwing, STORE_ID)).toBeNull();
  });
});

describe('lineageCoinId', () => {
  it('derives the known real coin id from real coin fields (cross-checked against coinset)', async () => {
    const id = await lineageCoinId({
      parentCoinInfo: hexToBytes('3d8361caba83212b273428a300ffdb87d439e8c86d37067e79e2bbe2cfa0f904'),
      puzzleHash: hexToBytes('eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9'),
      amount: 1n,
    });
    expect(id).toBe(STORE_ID);
  });

  it('derives the eve store coin id (the launcher spend\'s successor coin)', async () => {
    const id = await lineageCoinId({
      parentCoinInfo: hexToBytes(STORE_ID),
      puzzleHash: hexToBytes('3658364aae249138165a5e1e5ad1b6ce0fbab48e414d4391d7ab2a88b3da6ec5'),
      amount: 1n,
    });
    expect(id).toBe(EVE_COIN_ID);
  });
});

describe('makeFetchLineageClient', () => {
  function fakeFetch(handler: (url: string, body: unknown) => unknown): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const json = handler(url, body);
      return { json: async () => json } as Response;
    }) as typeof fetch;
  }

  it('getCoinRecord parses a real-shaped coinset response', async () => {
    const client = makeFetchLineageClient(
      'https://api.coinset.org',
      fakeFetch(() => ({ success: true, coin_record: { spent: true, spent_block_index: 8882302 } })),
    );
    expect(await client.getCoinRecord(STORE_ID)).toEqual({ spent: true, spentHeight: 8882302 });
  });

  it('getCoinRecord returns null on success:false / missing record', async () => {
    const client = makeFetchLineageClient('https://api.coinset.org', fakeFetch(() => ({ success: false })));
    expect(await client.getCoinRecord(STORE_ID)).toBeNull();
  });

  it('getCoinRecord returns null on a transport error (fetch throws)', async () => {
    const client = makeFetchLineageClient(
      'https://api.coinset.org',
      (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
    );
    expect(await client.getCoinRecord(STORE_ID)).toBeNull();
  });

  it('getCoinSpend parses a real-shaped coinset response into plain bytes', async () => {
    const client = makeFetchLineageClient(
      'https://api.coinset.org',
      fakeFetch(() => ({
        success: true,
        coin_solution: {
          coin: { parent_coin_info: `0x${'11'.repeat(32)}`, puzzle_hash: `0x${'22'.repeat(32)}`, amount: 1 },
          puzzle_reveal: '0xff01',
          solution: '0xff02',
        },
      })),
    );
    const spend = await client.getCoinSpend(STORE_ID, 8882302);
    expect(spend?.coin.amount).toBe(1n);
    expect(spend?.coin.parentCoinInfo).toEqual(hexToBytes('11'.repeat(32)));
    expect(spend?.puzzleReveal).toEqual(hexToBytes('ff01'));
  });

  it('getCoinSpend returns null on success:false / missing solution', async () => {
    const client = makeFetchLineageClient('https://api.coinset.org', fakeFetch(() => ({ success: false })));
    expect(await client.getCoinSpend(STORE_ID, 1)).toBeNull();
  });

  it('getCoinSpend returns null on a transport error (fetch throws)', async () => {
    const client = makeFetchLineageClient(
      'https://api.coinset.org',
      (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
    );
    expect(await client.getCoinSpend(STORE_ID, 1)).toBeNull();
  });
});
