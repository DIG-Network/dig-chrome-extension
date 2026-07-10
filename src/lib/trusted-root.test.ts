import { describe, it, expect } from 'vitest';
import {
  normalizeRoot,
  isRootlessRoot,
  resolveReadRoots,
  decideVerified,
  LATEST_ROOT,
} from './trusted-root';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);

describe('normalizeRoot', () => {
  it('accepts 64-hex, lowercasing + stripping a 0x prefix', () => {
    expect(normalizeRoot('0x' + 'AB'.repeat(32))).toBe('ab'.repeat(32));
    expect(normalizeRoot(ROOT_A)).toBe(ROOT_A);
  });
  it('rejects the latest sentinel / empty / short / non-hex / non-string as null', () => {
    expect(normalizeRoot(LATEST_ROOT)).toBeNull();
    expect(normalizeRoot('')).toBeNull();
    expect(normalizeRoot('abc')).toBeNull();
    expect(normalizeRoot('g'.repeat(64))).toBeNull(); // 64 chars but not hex
    expect(normalizeRoot(undefined)).toBeNull();
    expect(normalizeRoot(null)).toBeNull();
    expect(normalizeRoot(123 as unknown)).toBeNull();
  });
});

describe('isRootlessRoot', () => {
  it('is true for absent / latest / invalid, false for a concrete root', () => {
    expect(isRootlessRoot(undefined)).toBe(true);
    expect(isRootlessRoot(null)).toBe(true);
    expect(isRootlessRoot(LATEST_ROOT)).toBe(true);
    expect(isRootlessRoot('nope')).toBe(true);
    expect(isRootlessRoot(ROOT_A)).toBe(false);
  });
});

describe('resolveReadRoots', () => {
  it('rooted URN → trust + pin the URN root (anchored ignored)', () => {
    expect(resolveReadRoots(ROOT_A, null)).toEqual({ trustedRoot: ROOT_A, fetchRoot: ROOT_A });
    expect(resolveReadRoots(ROOT_A, ROOT_B)).toEqual({ trustedRoot: ROOT_A, fetchRoot: ROOT_A });
  });
  it('rootless URN + anchored resolved → trust + pin the anchored root', () => {
    expect(resolveReadRoots(LATEST_ROOT, ROOT_B)).toEqual({ trustedRoot: ROOT_B, fetchRoot: ROOT_B });
    expect(resolveReadRoots(null, ROOT_B)).toEqual({ trustedRoot: ROOT_B, fetchRoot: ROOT_B });
    expect(resolveReadRoots(undefined, ROOT_B)).toEqual({ trustedRoot: ROOT_B, fetchRoot: ROOT_B });
  });
  it('rootless URN + anchored unresolvable → fail-closed (trustedRoot null), fetch latest', () => {
    expect(resolveReadRoots(LATEST_ROOT, null)).toEqual({ trustedRoot: null, fetchRoot: LATEST_ROOT });
    expect(resolveReadRoots(null, undefined)).toEqual({ trustedRoot: null, fetchRoot: LATEST_ROOT });
    // a tampered / malformed anchored value is treated as unresolvable (never trusted).
    expect(resolveReadRoots(LATEST_ROOT, 'not-a-root')).toEqual({ trustedRoot: null, fetchRoot: LATEST_ROOT });
  });
});

describe('decideVerified (fail-closed)', () => {
  it('true only when a trusted root exists AND the proof folded to it', () => {
    expect(decideVerified(ROOT_A, true)).toBe(true);
  });
  it('false when the proof does not fold to the trusted root (wrong / tampered content)', () => {
    expect(decideVerified(ROOT_A, false)).toBe(false);
  });
  it('false when there is no trusted root, even if a fold was claimed (fail-closed)', () => {
    expect(decideVerified(null, true)).toBe(false);
    expect(decideVerified(null, false)).toBe(false);
  });
});
