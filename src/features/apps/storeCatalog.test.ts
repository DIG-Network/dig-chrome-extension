import { describe, it, expect } from 'vitest';
import { normalizeCatalog, STORE_JSON_URL } from '@/features/apps/storeCatalog';

describe('normalizeCatalog', () => {
  it('orders featured entries first, preserving within-group order', () => {
    const apps = normalizeCatalog({
      apps: [
        { slug: 'a', name: 'A', icon: 'https://x/a.png', link: 'https://a/', featured: false },
        { slug: 'b', name: 'B', icon: 'https://x/b.png', link: 'https://b/', featured: true },
        { slug: 'c', name: 'C', icon: 'https://x/c.png', link: 'https://c/', featured: false },
        { slug: 'd', name: 'D', icon: 'https://x/d.png', link: 'https://d/', featured: true },
      ],
    });
    expect(apps.map((a) => a.slug)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('drops malformed entries (missing slug/name or non-https icon/link)', () => {
    const apps = normalizeCatalog({
      apps: [
        { slug: '', name: 'no-slug', icon: 'https://x/x.png', link: 'https://x/' },
        { slug: 'ok', name: 'Ok', icon: 'https://x/ok.png', link: 'https://ok/' },
        { slug: 'http', name: 'Insecure', icon: 'http://x/x.png', link: 'https://x/' },
        { slug: 'nolink', name: 'No Link', icon: 'https://x/x.png' },
      ],
    });
    expect(apps.map((a) => a.slug)).toEqual(['ok']);
  });

  it('keeps category/accentColor when valid and defaults category otherwise', () => {
    const [a] = normalizeCatalog({ apps: [{ slug: 's', name: 'S', icon: 'https://x/s.png', link: 'https://s/', accentColor: '#3aaa35' }] });
    expect(a.category).toBe('other');
    expect(a.accentColor).toBe('#3aaa35');
    const [b] = normalizeCatalog({ apps: [{ slug: 't', name: 'T', icon: 'https://x/t.png', link: 'https://t/', category: 'tools', accentColor: 'not-a-color' }] });
    expect(b.category).toBe('tools');
    expect(b.accentColor).toBeUndefined();
  });

  it('is defensive against a missing/garbage manifest', () => {
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeCatalog({})).toEqual([]);
    expect(normalizeCatalog({ apps: 'nope' })).toEqual([]);
  });

  it('points at explore.dig.net/store.json', () => {
    expect(STORE_JSON_URL).toBe('https://explore.dig.net/store.json');
  });
});
