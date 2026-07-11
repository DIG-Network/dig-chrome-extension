/**
 * dig-serve-headers — parse the DIG Shields response headers the local dig-node sets on its
 * plaintext content-serve surface (#289/#292).
 *
 * On the node-served path the browser no longer verifies content itself — the trusted, loopback,
 * key-holding node verifies inclusion + the chain-anchored root server-side and exposes the verdict
 * via response headers, so the extension's DIG Shields ledger AND the injected toolbar badges keep
 * working without re-verifying:
 *   - `X-Dig-Verified: true|false` — inclusion + chain-anchored-root result (verified server-side).
 *   - `X-Dig-Root: <64-hex>`       — the anchored root the content was proven against.
 *   - `X-Dig-Source: local|peer|rpc` — where the MAIN resource was served from (drives #292's
 *     "Loaded from local" badge: was it the synced local `.dig`, a peer, or the public RPC).
 *
 * Pure (accepts a `Headers` instance OR a plain header object, case-insensitively) so it is
 * unit-tested; the content-script toolbar reads the served response's headers through it.
 */

/** Where the node served the main resource from. */
export type DigSource = 'local' | 'peer' | 'rpc';

/** The parsed server-side verification verdict. `verified: null` ⇒ the headers were absent (this
 *  was not a DIG node-served response — e.g. an ordinary website). */
export interface ServeVerdict {
  verified: boolean | null;
  root: string | null;
  source: DigSource | null;
}

type HeaderLike = Headers | Record<string, string | null | undefined> | null | undefined;

/** Read a header case-insensitively from a `Headers` instance or a plain object. */
function getHeader(h: HeaderLike, name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const rec = h as Record<string, string | null | undefined>;
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? rec[hit] ?? null : null;
}

/** Parse the `X-Dig-*` DIG Shields headers into a {@link ServeVerdict}. */
export function readServeHeaders(headers: HeaderLike): ServeVerdict {
  const rawVerified = getHeader(headers, 'X-Dig-Verified');
  const verified = rawVerified == null ? null : /^true$/i.test(rawVerified.trim());

  const rawRoot = getHeader(headers, 'X-Dig-Root');
  const root = rawRoot && /^[0-9a-f]{64}$/i.test(rawRoot.trim()) ? rawRoot.trim().toLowerCase() : null;

  const rawSource = (getHeader(headers, 'X-Dig-Source') || '').trim().toLowerCase();
  const source: DigSource | null =
    rawSource === 'local' || rawSource === 'peer' || rawSource === 'rpc' ? rawSource : null;

  return { verified, root, source };
}
