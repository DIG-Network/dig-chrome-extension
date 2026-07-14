import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isOlder,
  nodeVersionBadge,
  nodeVersionBadgeLabelId,
  nodeVersionBadgeTone,
} from '@/lib/node-version';

describe('compareVersions / isOlder', () => {
  it('treats equal releases as equal', () => {
    expect(compareVersions('0.31.1', '0.31.1')).toBe(0);
    expect(isOlder('0.31.1', '0.31.1')).toBe(false);
  });

  it('orders by patch, then minor, then major', () => {
    expect(compareVersions('0.31.0', '0.31.1')).toBe(-1);
    expect(compareVersions('0.31.9', '0.32.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('tolerates a leading "v" and a missing minor/patch', () => {
    expect(compareVersions('v0.31.1', '0.31.1')).toBe(0);
    expect(compareVersions('0.31', '0.31.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
  });

  it('ignores build metadata after "+"', () => {
    expect(compareVersions('0.31.1+abc123', '0.31.1+def456')).toBe(0);
  });

  it('ranks a prerelease strictly below its plain release', () => {
    expect(compareVersions('0.31.1-rc.1', '0.31.1')).toBe(-1);
    expect(compareVersions('0.31.1', '0.31.1-rc.1')).toBe(1);
  });

  it('compares two prereleases of the same release lexicographically', () => {
    expect(compareVersions('0.31.1-rc.1', '0.31.1-rc.2')).toBe(-1);
    expect(compareVersions('0.31.1-rc.2', '0.31.1-rc.1')).toBe(1);
    expect(compareVersions('0.31.1-rc.1', '0.31.1-rc.1')).toBe(0);
  });

  it('never throws on a malformed component (degrades to 0)', () => {
    expect(compareVersions('not-a-version', '0.0.1')).toBe(-1);
  });

  it('isOlder is a strict less-than over compareVersions', () => {
    expect(isOlder('0.30.0', '0.31.0')).toBe(true);
    expect(isOlder('0.31.0', '0.30.0')).toBe(false);
    expect(isOlder('0.31.0', '0.31.0')).toBe(false);
  });
});

describe('nodeVersionBadge', () => {
  it('is "nodeOffline" when the node is not connected, regardless of any other input', () => {
    expect(
      nodeVersionBadge({ nodeOnline: false, runningVersion: '0.31.1', latestVersion: '0.31.1' }),
    ).toEqual({ kind: 'nodeOffline' });
  });

  it('is "nodeOffline" when connected but the running version is not yet known', () => {
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: null, latestVersion: '0.31.1' })).toEqual({
      kind: 'nodeOffline',
    });
  });

  it('is "feedUnreachable" — NEVER a false "up to date" — when the feed has no answer', () => {
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.31.1', latestVersion: null })).toEqual({
      kind: 'feedUnreachable',
    });
  });

  it('is "feedUnreachable" when the feed version is present but malformed (no digits in release)', () => {
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.31.1', latestVersion: 'invalid' })).toEqual({
      kind: 'feedUnreachable',
    });
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.31.1', latestVersion: '' })).toEqual({
      kind: 'feedUnreachable',
    });
  });

  it('is "upToDate" when the running version matches or exceeds the feed', () => {
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.31.1', latestVersion: '0.31.1' })).toEqual({
      kind: 'upToDate',
    });
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.32.0', latestVersion: '0.31.1' })).toEqual({
      kind: 'upToDate',
    });
  });

  it('is "updateAvailable" (carrying the latest version) when the running version is older', () => {
    expect(nodeVersionBadge({ nodeOnline: true, runningVersion: '0.30.0', latestVersion: '0.31.1' })).toEqual({
      kind: 'updateAvailable',
      latestVersion: '0.31.1',
    });
  });
});

describe('nodeVersionBadgeLabelId / nodeVersionBadgeTone', () => {
  it('maps every kind to a distinct message id', () => {
    const kinds = ['nodeOffline', 'feedUnreachable', 'upToDate', 'updateAvailable'] as const;
    const ids = kinds.map(nodeVersionBadgeLabelId);
    expect(new Set(ids).size).toBe(kinds.length);
    for (const id of ids) expect(id.startsWith('updates.nodeVersion.badge.')).toBe(true);
  });

  it('only "updateAvailable" gets the attention-grabbing tone; the unknown kinds stay neutral', () => {
    expect(nodeVersionBadgeTone('upToDate')).toBe('good');
    expect(nodeVersionBadgeTone('updateAvailable')).toBe('warn');
    expect(nodeVersionBadgeTone('nodeOffline')).toBe('neutral');
    expect(nodeVersionBadgeTone('feedUnreachable')).toBe('neutral');
  });
});
