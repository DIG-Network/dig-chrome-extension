import { describe, it, expect, vi } from 'vitest';
import {
  parseCatRegistry,
  resolveCatMeta,
  denomToDecimals,
  shortTail,
  fetchCatRegistry,
  CAT_DECIMALS,
  DEXIE_TOKENS_URL,
} from './catMetadata';

const SBX = 'a628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913';
const DIG = 'a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81';

describe('shortTail', () => {
  it('renders a middle-elided short form', () => {
    expect(shortTail(DIG)).toBe('a406d3…2f81');
  });
  it('tolerates a 0x prefix and short input', () => {
    expect(shortTail(`0x${DIG}`)).toBe('a406d3…2f81');
    expect(shortTail('abcd')).toBe('abcd');
  });
});

describe('denomToDecimals', () => {
  it('maps a power-of-ten denom to decimals', () => {
    expect(denomToDecimals(1000)).toBe(3);
    expect(denomToDecimals(1)).toBe(0); // a whole-unit CAT (log10(1) = 0)
    expect(denomToDecimals(1_000_000)).toBe(6);
  });
  it('falls back for a missing/garbage/absurd denom', () => {
    expect(denomToDecimals(undefined)).toBe(CAT_DECIMALS);
    expect(denomToDecimals('nope')).toBe(CAT_DECIMALS);
    expect(denomToDecimals(0)).toBe(CAT_DECIMALS);
  });
});

describe('parseCatRegistry', () => {
  it('indexes tokens by lowercased TAIL with name/ticker/icon/decimals', () => {
    const map = parseCatRegistry({
      success: true,
      tokens: [
        { id: SBX, name: 'Spacebucks', code: 'SBX', denom: 1000, icon: `https://icons.dexie.space/${SBX}.webp` },
      ],
    });
    expect(map[SBX]).toEqual({
      name: 'Spacebucks',
      ticker: 'SBX',
      iconUrl: `https://icons.dexie.space/${SBX}.webp`,
      decimals: 3,
    });
  });

  it('drops entries with a bad id and tolerates a non-array / non-object', () => {
    expect(parseCatRegistry({ tokens: [{ id: 'not-a-tail', code: 'X' }] })).toEqual({});
    expect(parseCatRegistry({})).toEqual({});
    expect(parseCatRegistry(null)).toEqual({});
    expect(parseCatRegistry('garbage')).toEqual({});
  });

  it('falls back to short-form name + CAT ticker + null icon for missing fields', () => {
    const map = parseCatRegistry({ tokens: [{ id: DIG }] });
    expect(map[DIG]).toEqual({ name: 'a406d3…2f81', ticker: 'CAT', iconUrl: null, decimals: CAT_DECIMALS });
  });

  it('rejects a non-https icon (no javascript:/http)', () => {
    const map = parseCatRegistry({ tokens: [{ id: SBX, code: 'SBX', icon: 'javascript:alert(1)' }] });
    expect(map[SBX].iconUrl).toBeNull();
  });
});

describe('resolveCatMeta', () => {
  const registry = parseCatRegistry({ tokens: [{ id: SBX, name: 'Spacebucks', code: 'SBX', denom: 1000, icon: `https://icons.dexie.space/${SBX}.webp` }] });

  it('resolves a known TAIL (case/0x-insensitive)', () => {
    expect(resolveCatMeta(`0x${SBX.toUpperCase()}`, registry).ticker).toBe('SBX');
  });

  it('degrades to short-form for an unknown TAIL', () => {
    expect(resolveCatMeta(DIG, registry)).toEqual({ name: 'a406d3…2f81', ticker: 'CAT', iconUrl: null, decimals: CAT_DECIMALS });
  });

  it('degrades gracefully with no registry at all', () => {
    expect(resolveCatMeta(SBX, null).ticker).toBe('CAT');
    expect(resolveCatMeta(SBX, undefined).iconUrl).toBeNull();
  });
});

describe('fetchCatRegistry', () => {
  it('GETs the dexie tokens endpoint and parses it', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tokens: [{ id: SBX, name: 'Spacebucks', code: 'SBX', denom: 1000 }] }),
    })) as unknown as typeof fetch;
    const map = await fetchCatRegistry(fetchImpl);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(DEXIE_TOKENS_URL);
    expect(map[SBX].name).toBe('Spacebucks');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchCatRegistry(fetchImpl)).rejects.toThrow('HTTP 503');
  });
});
