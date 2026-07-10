import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  cacheUsagePercent,
  parseCapToBytes,
  cachedEntriesView,
  cacheStatsView,
  MIN_CACHE_CAP_BYTES,
} from '@/lib/dig-cache';

describe('formatBytes', () => {
  it('humanizes across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MiB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GiB');
  });
  it('defends against bad input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

describe('cacheUsagePercent', () => {
  it('is a clamped integer percentage', () => {
    expect(cacheUsagePercent(0, 100)).toBe(0);
    expect(cacheUsagePercent(50, 100)).toBe(50);
    expect(cacheUsagePercent(200, 100)).toBe(100); // clamped
    expect(cacheUsagePercent(10, 0)).toBe(0); // no cap → 0
  });
});

describe('parseCapToBytes', () => {
  it('parses MiB/GiB and floors at the 64 MiB minimum', () => {
    expect(parseCapToBytes('128', 'MiB')).toBe(128 * 1024 * 1024);
    expect(parseCapToBytes('2', 'GiB')).toBe(2 * 1024 * 1024 * 1024);
    // Below the floor is raised to it.
    expect(parseCapToBytes('10', 'MiB')).toBe(MIN_CACHE_CAP_BYTES);
  });
  it('rejects non-positive / non-numeric', () => {
    expect(parseCapToBytes('0', 'MiB')).toBeNull();
    expect(parseCapToBytes('-4', 'GiB')).toBeNull();
    expect(parseCapToBytes('abc', 'MiB')).toBeNull();
  });
});

describe('cachedEntriesView', () => {
  it('orders by lru_rank (0 = next evicted) and humanizes', () => {
    const view = cachedEntriesView([
      { store_id: 'aa', root: '11', size_bytes: 2048, last_used_unix_ms: 200, lru_rank: 1 },
      { store_id: 'bb', root: '22', size_bytes: 1024, last_used_unix_ms: 100, lru_rank: 0 },
    ]);
    expect(view.map((v) => v.lruRank)).toEqual([0, 1]);
    expect(view[0].storeId).toBe('bb');
    expect(view[0].key).toBe('bb:22');
    expect(view[0].sizeLabel).toBe('1 KiB');
    expect(view[1].sizeLabel).toBe('2 KiB');
  });
  it('tolerates empty/absent', () => {
    expect(cachedEntriesView(null)).toEqual([]);
    expect(cachedEntriesView(undefined)).toEqual([]);
  });
});

describe('cacheStatsView', () => {
  it('humanizes + derives usage and hit-rate', () => {
    const v = cacheStatsView({
      cap_bytes: 100 * 1024 * 1024,
      used_bytes: 25 * 1024 * 1024,
      entry_count: 3,
      total_bytes: 25 * 1024 * 1024,
      evicted_count: 2,
      evicted_bytes: 5 * 1024 * 1024,
      content_cache: { hits: 3, misses: 1 },
    });
    expect(v.entryCount).toBe(3);
    expect(v.usedLabel).toBe('25 MiB');
    expect(v.capLabel).toBe('100 MiB');
    expect(v.usagePercent).toBe(25);
    expect(v.evictedCount).toBe(2);
    expect(v.hitRatePercent).toBe(75);
  });
  it('reports null hit-rate before any lookups', () => {
    expect(cacheStatsView({ content_cache: { hits: 0, misses: 0 } }).hitRatePercent).toBeNull();
    expect(cacheStatsView(null).hitRatePercent).toBeNull();
  });
});
