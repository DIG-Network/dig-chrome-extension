/**
 * Tests for the Chia/DIG-native phishing / malicious-origin protection (#67 P0-2).
 *
 * `assessOrigin` decides, before a webpage may connect to or spend from the wallet, whether its
 * origin is a known-bad site (a DIG-curated blocklist) or a deceptive lookalike of a legitimate DIG
 * surface (homoglyph or subdomain-spoof of a known DIG domain). Original code — no imported Ethereum
 * phishing list. Pure: the blocklist is passed in (the SW refreshes it into chrome.storage).
 */
import { describe, it, expect } from 'vitest';
import { assessOrigin, parseBlocklistPayload, originHostname, PHISHING } from '@/lib/phishing';

describe('originHostname', () => {
  it('extracts the hostname from an origin', () => {
    expect(originHostname('https://dapp.example.com')).toBe('dapp.example.com');
    expect(originHostname('https://Hub.DIG.net:443')).toBe('hub.dig.net');
  });
  it('returns null for a non-origin / empty', () => {
    expect(originHostname('')).toBeNull();
    expect(originHostname('not a url')).toBeNull();
  });
});

describe('assessOrigin — blocklist', () => {
  it('ok for an ordinary unknown dApp origin', () => {
    const r = assessOrigin('https://cool-dapp.example', []);
    expect(r.verdict).toBe('ok');
    expect(r.reason).toBeNull();
  });

  it('blocks an origin whose hostname is on the blocklist', () => {
    const r = assessOrigin('https://evil-drainer.com', ['evil-drainer.com']);
    expect(r.verdict).toBe('block');
    expect(r.reason).toBe(PHISHING.BLOCKLISTED);
  });

  it('blocks a subdomain of a blocklisted registrable domain', () => {
    const r = assessOrigin('https://login.evil-drainer.com', ['evil-drainer.com']);
    expect(r.verdict).toBe('block');
  });

  it('does not block a domain that merely ends with a blocklist string as a non-label boundary', () => {
    // 'notevil-drainer.com' must NOT match a 'evil-drainer.com' entry (label-boundary match only).
    const r = assessOrigin('https://notevil-drainer.com', ['evil-drainer.com']);
    expect(r.verdict).toBe('ok');
  });
});

describe('assessOrigin — DIG lookalikes', () => {
  it('allows a genuine DIG surface and its subdomains', () => {
    expect(assessOrigin('https://hub.dig.net', []).verdict).toBe('ok');
    expect(assessOrigin('https://mystore.on.dig.net', []).verdict).toBe('ok');
    expect(assessOrigin('https://dig.net', []).verdict).toBe('ok');
  });

  it('warns on a deceptive subdomain-spoof of a DIG domain (real registrable domain is the attacker)', () => {
    const r = assessOrigin('https://hub.dig.net.wallet-verify.com', []);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe(PHISHING.LOOKALIKE);
  });

  it('warns on a homoglyph lookalike of a DIG domain', () => {
    // 'dıg.net' (dotless-i) skeletonizes to 'dig.net' but is a different registration.
    const r = assessOrigin('https://hub.dıg.net', []);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe(PHISHING.LOOKALIKE);
  });

  it('a blocklist hit takes precedence over a lookalike warn', () => {
    const r = assessOrigin('https://hub.dig.net.wallet-verify.com', ['wallet-verify.com']);
    expect(r.verdict).toBe('block');
  });
});

describe('parseBlocklistPayload', () => {
  it('accepts a { domains: [...] } payload and normalizes/dedupes hostnames', () => {
    const list = parseBlocklistPayload({ domains: ['Evil.com', 'evil.com', ' bad.example '] });
    expect(list).toContain('evil.com');
    expect(list).toContain('bad.example');
    expect(list.filter((d) => d === 'evil.com')).toHaveLength(1);
  });
  it('accepts a bare array payload', () => {
    expect(parseBlocklistPayload(['a.com', 'b.com'])).toEqual(['a.com', 'b.com']);
  });
  it('returns [] for a malformed payload', () => {
    expect(parseBlocklistPayload(null)).toEqual([]);
    expect(parseBlocklistPayload({ nope: 1 })).toEqual([]);
    expect(parseBlocklistPayload('string')).toEqual([]);
  });
  it('drops non-string / empty entries', () => {
    expect(parseBlocklistPayload({ domains: ['ok.com', 42, '', null] })).toEqual(['ok.com']);
  });
});
