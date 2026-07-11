import { describe, it, expect } from 'vitest';
import { parseChiaNav, buildNodeServeUrl, chooseNavTarget, NODE_SERVE_PREFIX } from '@/lib/dig-nav';

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);
const NODE = 'http://dig.local';
const NODE_LOOPBACK = 'http://127.0.0.1:9778';

describe('parseChiaNav', () => {
  it('parses a chia:// URL with store + root + path', () => {
    const p = parseChiaNav(`chia://urn:dig:chia:${STORE}:${ROOT}/app.js`);
    expect(p).toMatchObject({ storeId: STORE, roothash: ROOT, resourceKey: 'app.js' });
  });

  it('parses the chain-prefixed form the omnibox emits (chia://chia:<store>)', () => {
    const p = parseChiaNav(`chia://chia:${STORE}`);
    expect(p).toMatchObject({ storeId: STORE, roothash: null });
  });

  it('parses a bare rootless store id', () => {
    const p = parseChiaNav(`chia://${STORE}/index.html`);
    expect(p).toMatchObject({ storeId: STORE, roothash: null, resourceKey: 'index.html' });
  });

  it('returns null for a non-DIG address', () => {
    expect(parseChiaNav('https://example.com')).toBeNull();
    expect(parseChiaNav('')).toBeNull();
    expect(parseChiaNav(null)).toBeNull();
  });
});

describe('buildNodeServeUrl', () => {
  it('builds a rooted capsule serve URL under /s/', () => {
    const p = parseChiaNav(`chia://urn:dig:chia:${STORE}:${ROOT}/app.js`)!;
    expect(buildNodeServeUrl(NODE, p)).toBe(`http://dig.local/s/${STORE}:${ROOT}/app.js`);
  });

  it('omits the :root segment for a rootless URN (node serves the latest capsule)', () => {
    const p = parseChiaNav(`chia://${STORE}/index.html`)!;
    expect(buildNodeServeUrl(NODE, p)).toBe(`http://dig.local/s/${STORE}/index.html`);
  });

  it('serves a bare capsule as a trailing slash (node applies its default entry key)', () => {
    const p = parseChiaNav(`chia://${STORE}`)!;
    expect(buildNodeServeUrl(NODE, p)).toBe(`http://dig.local/s/${STORE}/`);
  });

  it('normalizes a trailing slash on the node base', () => {
    const p = parseChiaNav(`chia://${STORE}/index.html`)!;
    expect(buildNodeServeUrl('http://dig.local/', p)).toBe(`http://dig.local/s/${STORE}/index.html`);
  });

  it('carries a private-store salt as a query param', () => {
    const p = parseChiaNav(`chia://${STORE}/secret.html?salt=deadbeef`)!;
    expect(buildNodeServeUrl(NODE_LOOPBACK, p)).toBe(`http://127.0.0.1:9778/s/${STORE}/secret.html?salt=deadbeef`);
  });

  it('exposes the /s/ mount prefix as a constant', () => {
    expect(NODE_SERVE_PREFIX).toBe('/s/');
  });
});

describe('chooseNavTarget', () => {
  it('a reachable local node → navigate the tab to the node-served plaintext surface (#289)', () => {
    const t = chooseNavTarget({ digUrl: `chia://urn:dig:chia:${STORE}:${ROOT}/app.js`, nodeBase: NODE });
    expect(t.kind).toBe('node');
    if (t.kind === 'node') {
      expect(t.url).toBe(`http://dig.local/s/${STORE}:${ROOT}/app.js`);
      expect(t).toMatchObject({ storeId: STORE, root: ROOT, resourceKey: 'app.js' });
    }
  });

  it('no local node → keep the sandbox viewer + rpc path (browser cannot get plaintext from the gateway)', () => {
    const t = chooseNavTarget({ digUrl: `chia://urn:dig:chia:${STORE}/index.html`, nodeBase: null });
    expect(t.kind).toBe('sandbox');
    if (t.kind === 'sandbox') {
      expect(t.urn).toBe(`urn:dig:chia:${STORE}/index.html`);
    }
  });

  it('honors a custom-node base (§5.3 override wins the ladder upstream of this fn)', () => {
    const t = chooseNavTarget({ digUrl: `chia://${STORE}/x.png`, nodeBase: 'http://my-node.example.com:9000' });
    expect(t.kind).toBe('node');
    if (t.kind === 'node') expect(t.url).toBe(`http://my-node.example.com:9000/s/${STORE}/x.png`);
  });

  it('an unparseable address falls back to the sandbox viewer (which renders the friendly error), even with a node up', () => {
    const bad = chooseNavTarget({ digUrl: 'chia://not-a-store', nodeBase: NODE });
    expect(bad.kind).toBe('sandbox');
    if (bad.kind === 'sandbox') expect(bad.urn).toBe('not-a-store');
    const empty = chooseNavTarget({ digUrl: '', nodeBase: null });
    expect(empty.kind).toBe('sandbox');
    if (empty.kind === 'sandbox') expect(empty.urn).toBe('');
  });
});
