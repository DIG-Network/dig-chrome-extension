import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_COINSET_URL as CHAIN_COINSET_URL } from '@/offscreen/chain';
import { DEFAULT_COINSET_URL as SESSION_COINSET_URL } from '@/lib/custody-session';

/**
 * Regression #122 (P0, live wallet-breaker): the offscreen chain client fetches
 * `https://api.coinset.org`, but the MV3 manifest only allowed `https://coinset.org` (the apex).
 * CSP host-source matching does NOT cover subdomains, so every offscreen fetch to the api. host was
 * blocked (`Failed to fetch`) → balances / send / broadcast / activity / NFTs / offers all silently
 * failed on real mainnet. CI missed it because the e2e mocks coinset; only a live host hits the block.
 *
 * This test pins the invariant that can't be mocked away: EVERY coinset host the chain client
 * actually constructs MUST be present in BOTH the manifest `host_permissions` AND the extension-pages
 * CSP `connect-src`. It fails first on the missing `api.` host and guards against a future regression
 * (a client base-URL change that outruns the manifest allow-list).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
};

/** The connect-src token list from the extension-pages CSP. */
function connectSrcTokens(): string[] {
  const csp = manifest.content_security_policy.extension_pages;
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  if (!directive) return [];
  return directive.split(/\s+/).slice(1); // drop the "connect-src" keyword
}

/** True if `origin` (e.g. https://api.coinset.org) is covered by a host_permissions pattern. */
function hostPermissionCovers(origin: string): boolean {
  return manifest.host_permissions.includes(`${origin}/*`);
}

/** Every distinct coinset origin the chain client can construct as its default base URL. */
const clientCoinsetOrigins = [...new Set([CHAIN_COINSET_URL, SESSION_COINSET_URL].map((u) => new URL(u).origin))];

describe('manifest allows every coinset host the chain client uses (#122)', () => {
  it('the chain client and the SW session agree on the default coinset URL', () => {
    expect(CHAIN_COINSET_URL).toBe(SESSION_COINSET_URL);
  });

  it.each(clientCoinsetOrigins)('CSP connect-src allows %s', (origin) => {
    expect(connectSrcTokens()).toContain(origin);
  });

  it.each(clientCoinsetOrigins)('host_permissions allows %s', (origin) => {
    expect(hostPermissionCovers(origin)).toBe(true);
  });
});
