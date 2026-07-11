import { describe, it, expect, vi } from 'vitest';
import { classifyDigInput, isDigShapedInput, resolveOnDigNetUrn, X_DIG_URN_HEADER } from '@/lib/dig-nav';
import { storeHexToDigLabel } from '@/lib/dig-dns-host';

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);

/** A dig-dns `.dig` host label is the base32 store id (§5.5) — build it from the hex so the test
 *  proves the real codec round-trips, not a hardcoded label. */
const STORE_LABEL = storeHexToDigLabel(STORE)!;
const ROOT_LABEL = storeHexToDigLabel(ROOT)!;

describe('classifyDigInput — the shared multi-tier entry classifier (#362/#310)', () => {
  it('classifies a chia:// address (bare capsule) as a urn with a canonical chia:// URL', () => {
    const c = classifyDigInput(`chia://${STORE}`);
    expect(c.kind).toBe('urn');
    if (c.kind === 'urn') expect(c.chiaUrl).toContain(STORE);
  });

  it('classifies a chia:// address with root + path as a urn (root preserved)', () => {
    const c = classifyDigInput(`chia://chia:${STORE}:${ROOT}/app.js`);
    expect(c.kind).toBe('urn');
    if (c.kind === 'urn') {
      expect(c.chiaUrl).toContain(STORE);
      expect(c.chiaUrl).toContain(ROOT);
      expect(c.chiaUrl).toContain('app.js');
    }
  });

  it('classifies the bare urn:dig:chia: scheme form as a urn (#310 — no chia:// / no keyword)', () => {
    const c = classifyDigInput(`urn:dig:chia:${STORE}:${ROOT}/index.html`);
    expect(c.kind).toBe('urn');
    if (c.kind === 'urn') expect(c.chiaUrl).toContain(`${STORE}:${ROOT}`);
  });

  it('classifies a chainless urn:dig: and a bare 64-hex store id as a urn', () => {
    expect(classifyDigInput(`urn:dig:${STORE}`).kind).toBe('urn');
    expect(classifyDigInput(STORE).kind).toBe('urn');
    expect(classifyDigInput(`${STORE}/logo.png`).kind).toBe('urn');
  });

  it('classifies a dig-dns .dig store-label host as a urn (canonical chia:// via the base32 codec)', () => {
    const c = classifyDigInput(`${STORE_LABEL}.dig`);
    expect(c.kind).toBe('urn');
    if (c.kind === 'urn') expect(c.chiaUrl).toContain(STORE);
  });

  it('classifies a chia://<rootLabel>.<storeLabel>.dig pinned host as a urn with store:root', () => {
    const c = classifyDigInput(`chia://${ROOT_LABEL}.${STORE_LABEL}.dig/x.css`);
    expect(c.kind).toBe('urn');
    if (c.kind === 'urn') {
      expect(c.chiaUrl).toContain(`${STORE}:${ROOT}`);
      expect(c.chiaUrl).toContain('x.css');
    }
  });

  it('classifies a HUMAN .dig name (not a base32 store id) as an on.dig.net shorthand (#308)', () => {
    const c = classifyDigInput('alice.dig');
    expect(c.kind).toBe('on-dig-net');
    if (c.kind === 'on-dig-net') expect(c.host).toBe('alice.on.dig.net');
  });

  it('classifies chia://alice.dig the same on.dig.net shorthand way', () => {
    const c = classifyDigInput('chia://alice.dig');
    expect(c.kind).toBe('on-dig-net');
    if (c.kind === 'on-dig-net') expect(c.host).toBe('alice.on.dig.net');
  });

  it('classifies <sub>.on.dig.net and chia://<sub>.on.dig.net as on-dig-net (canonical host)', () => {
    expect(classifyDigInput('shop.on.dig.net')).toEqual({ kind: 'on-dig-net', host: 'shop.on.dig.net' });
    expect(classifyDigInput('chia://shop.on.dig.net')).toEqual({ kind: 'on-dig-net', host: 'shop.on.dig.net' });
  });

  it('does NOT mistake ordinary *.dig.net hosts (hub/rpc) for DIG addresses', () => {
    expect(classifyDigInput('hub.dig.net').kind).toBe('url');
    expect(classifyDigInput('rpc.dig.net').kind).toBe('url');
  });

  it('classifies http(s) URLs and bare domains as url (bare domains get https://)', () => {
    expect(classifyDigInput('https://example.com/x')).toEqual({ kind: 'url', url: 'https://example.com/x' });
    expect(classifyDigInput('example.com/path')).toEqual({ kind: 'url', url: 'https://example.com/path' });
  });

  it('classifies free text (and empty) as a web search', () => {
    expect(classifyDigInput('what is dig')).toEqual({ kind: 'web', query: 'what is dig' });
    expect(classifyDigInput('')).toEqual({ kind: 'web', query: '' });
    expect(classifyDigInput('   ')).toEqual({ kind: 'web', query: '' });
  });

  it('isDigShapedInput is true for urn + on-dig-net, false for url + web', () => {
    expect(isDigShapedInput(`chia://${STORE}`)).toBe(true);
    expect(isDigShapedInput('alice.dig')).toBe(true);
    expect(isDigShapedInput('shop.on.dig.net')).toBe(true);
    expect(isDigShapedInput('https://example.com')).toBe(false);
    expect(isDigShapedInput('hello world')).toBe(false);
  });
});

describe('resolveOnDigNetUrn — HEAD→URN contract (#308)', () => {
  const headOk = (urn: string) =>
    vi.fn(async () => ({ ok: true, headers: new Headers({ [X_DIG_URN_HEADER]: urn }) }) as unknown as Response);

  it('reads X-Dig-URN from a HEAD and returns the canonical chia:// URL', async () => {
    const fetchImpl = headOk(`urn:dig:chia:${STORE}:${ROOT}`);
    const url = await resolveOnDigNetUrn('shop.on.dig.net', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://shop.on.dig.net/', { method: 'HEAD', cache: 'no-store' });
    expect(url).toContain(`${STORE}:${ROOT}`);
  });

  it('returns null for an unmapped subdomain (non-ok / no header)', async () => {
    const notFound = vi.fn(async () => ({ ok: false, headers: new Headers() }) as unknown as Response);
    expect(await resolveOnDigNetUrn('nope.on.dig.net', notFound)).toBeNull();
    const noHeader = vi.fn(async () => ({ ok: true, headers: new Headers() }) as unknown as Response);
    expect(await resolveOnDigNetUrn('nope.on.dig.net', noHeader)).toBeNull();
  });

  it('returns null for a malformed X-Dig-URN and never throws on a network error', async () => {
    const bad = vi.fn(async () => ({ ok: true, headers: new Headers({ [X_DIG_URN_HEADER]: 'not-a-urn' }) }) as unknown as Response);
    expect(await resolveOnDigNetUrn('x.on.dig.net', bad)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await resolveOnDigNetUrn('x.on.dig.net', boom)).toBeNull();
  });
});
