/**
 * dig-nav — pure §5.3 navigation-target construction for a `chia://` address (#289).
 *
 * When the extension intercepts a `chia://` navigation (or an omnibox entry, #291), it chooses
 * between TWO render paths based on whether a LOCAL dig-node is reachable (the §5.3 ladder +
 * custom-node override, resolved upstream by `server-config.resolveDigNode`):
 *
 *   - a local node IS reachable → navigate the TAB DIRECTLY to the node's plaintext content-serve
 *     surface `GET <nodeBase>/s/<storeId>[:<root>]/<path>` — an ordinary website. The trusted,
 *     loopback, key-holding node decrypts server-side and sets the DIG Shields response headers
 *     (`dig-serve-headers`). This REPLACES the sandbox viewer for the local-node case.
 *   - NO local node → keep the existing sandbox `dig-viewer` + rpc.dig.net ciphertext + in-browser
 *     decrypt path. A browser CANNOT obtain plaintext from the public gateway, so privacy is
 *     preserved: plaintext only ever crosses loopback.
 *
 * This is the PURE decision core (no chrome-API / DOM access) so it is unit-tested; the background
 * SW glue resolves the node base with `resolveDigNode` and then calls {@link chooseNavTarget} here.
 */
import { parseURN, type ParsedUrn } from '@/lib/dig-urn';
import { parseOpenUrnInput, buildContentViewUrl } from '@/lib/open-urn';
import { digLabelToStoreHex } from '@/lib/dig-dns-host';

/** The node's plaintext content-serve mount (#289): `GET <nodeBase>/s/<storeId>[:<root>]/<path>`. */
export const NODE_SERVE_PREFIX = '/s/';

/** The render target chosen for a `chia://` navigation. */
export type NavTarget =
  | {
      kind: 'node';
      /** The node-served plaintext URL to navigate the tab to. */
      url: string;
      storeId: string;
      root: string | null;
      resourceKey: string;
      salt: string | null;
    }
  | {
      kind: 'sandbox';
      /** The `chia://`-stripped URN the `dig-viewer` page expects as its `?urn=` param. */
      urn: string;
    };

/**
 * Parse a `chia://` URL / URN into its capsule + resource, or `null` if it is not a well-formed DIG
 * address. Delegates to the shared {@link parseURN} (which already strips `chia://`, `urn:dig:`, and
 * an optional chain prefix and validates the 64-hex store id / root).
 */
export function parseChiaNav(digUrl: string | null | undefined): ParsedUrn | null {
  if (!digUrl) return null;
  return parseURN(String(digUrl));
}

/**
 * Build the node's plaintext serve URL for a parsed capsule:
 *   `<nodeBase>/s/<storeId>[:<root>]/<resourceKey>[?salt=<hex>]`
 *
 * A rootless URN omits the `:root` segment (the node serves the store's latest capsule). A bare
 * capsule (no resource) becomes a trailing slash so the node applies its own `DEFAULT_RESOURCE_KEY`
 * (`index.html`). A private-store salt rides as `?salt=<hex>`. Any trailing slash on `nodeBase`
 * (e.g. `http://dig.local/`) is normalized away so the `/s/` mount is never doubled.
 */
export function buildNodeServeUrl(nodeBase: string, parsed: ParsedUrn): string {
  const base = String(nodeBase || '').replace(/\/+$/, '');
  const capsule = parsed.roothash ? `${parsed.storeId}:${parsed.roothash}` : parsed.storeId;
  const key = parsed.resourceKey || '';
  let url = `${base}${NODE_SERVE_PREFIX}${capsule}/${key}`;
  if (parsed.salt) url += `?salt=${parsed.salt}`;
  return url;
}

/**
 * Choose the render target for a `chia://` navigation given the §5.3-resolved local node base
 * (`resolveDigNode`'s result, or `null` when no local node is reachable — the ladder + override
 * precedence is applied by the caller).
 *
 * The node path is taken ONLY when a local node is reachable AND the address parses to a valid
 * capsule (the node can only serve a well-formed `/s/<store>[:root]/…`). EVERY other case — no local
 * node, or an unparseable/garbage address — falls back to the sandbox `dig-viewer`, which renders a
 * valid capsule and shows the branded friendly-error for a bad one. So node-serve is purely additive:
 * it changes behaviour only for the (local-node-up + valid-URN) case, leaving the existing sandbox
 * path unchanged everywhere else.
 */
export function chooseNavTarget(opts: { digUrl: string | null | undefined; nodeBase: string | null }): NavTarget {
  const parsed = parseChiaNav(opts.digUrl);
  if (opts.nodeBase && parsed) {
    return {
      kind: 'node',
      url: buildNodeServeUrl(opts.nodeBase, parsed),
      storeId: parsed.storeId,
      root: parsed.roothash,
      resourceKey: parsed.resourceKey || '',
      salt: parsed.salt,
    };
  }
  // Sandbox path: the `dig-viewer` page takes the `chia://`-stripped URN it currently expects (it
  // reparses + shows the friendly error for an unparseable value).
  return { kind: 'sandbox', urn: String(opts.digUrl ?? '').replace(/^chia:\/\//i, '') };
}

// ============================================================================
// Shared multi-tier ENTRY classifier (#362 / #310) — ONE resolve/nav core for every entry surface.
//
// Every DIG entry surface (the `dig` omnibox #291, raw `chia://` / `urn:` URL-bar interception #310,
// the injected + built-in toolbar URN bars #306, and the custom DIG search provider #362) funnels
// the user's raw input through {@link classifyDigInput} so the "is this a DIG address, and if so what
// canonical `chia://` does it map to?" decision is made in EXACTLY ONE place. No per-tier reimplement.
//
// The forms recognized as DIG (`urn` / `on-dig-net`), each with or without a leading `chia://`:
//   - `chia://<storeId>[:<root>][/<path>]`               → urn  (bare capsule / rooted / with path)
//   - `urn:dig:chia:<storeId>[:<root>][/<path>]`          → urn  (#310 bare `urn:` scheme, `dig` kw)
//   - `urn:dig:<storeId>…` / bare `<64hex>[:root][/path]` → urn  (chainless + no-prefix forms)
//   - `<label>.dig` / `<rootLabel>.<label>.dig`           → urn  (dig-dns base32 store label, §5.5 host)
//   - `<name>.dig` (a human label, NOT a base32 store id) → on-dig-net (shorthand for `.on.dig.net`)
//   - `<sub>.on.dig.net`                                  → on-dig-net (resolved HEAD→URN #308)
// Everything else is a normal `url` (http(s) / bare domain) or a free-text `web` search.
// ============================================================================

/** The classification of a raw entry-surface input (#362). */
export type DigInputClass =
  | {
      /** A DIG address that parses to a canonical `chia://` URL — load via {@link chooseNavTarget}. */
      kind: 'urn';
      /** The canonical `chia://chia:<storeId>[:<root>]/<key>` URL (from `open-urn`, one canonicalizer). */
      chiaUrl: string;
    }
  | {
      /** An `*.on.dig.net`-published store referenced by subdomain — resolved HEAD→URN (#308). */
      kind: 'on-dig-net';
      /** The canonical `<sub>.on.dig.net` host to `HEAD` for its `X-Dig-URN` (`resolveOnDigNetUrn`). */
      host: string;
    }
  | {
      /** A non-DIG web address — navigate straight to it (http(s) added for a bare domain). */
      kind: 'url';
      url: string;
    }
  | {
      /** Free-text — hand to the configurable fallback search engine (`search-fallback`). */
      kind: 'web';
      query: string;
    };

/** The `.dig` DNS suffix (dig-dns host form) and the `.on.dig.net` subdomain suffix. */
const DIG_SUFFIX = '.dig';
const ON_DIG_NET_SUFFIX = '.on.dig.net';

/** Extract the host authority of an input: strip a leading scheme, then take up to the first `/?#`. */
function hostOf(input: string): string {
  const noScheme = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const m = noScheme.match(/^([^/?#]*)/);
  return (m ? m[1] : '').toLowerCase();
}

/** The path (+ query) after the host authority of an input (without the leading slash). */
function pathOf(input: string): string {
  const noScheme = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = noScheme.indexOf('/');
  return slash === -1 ? '' : noScheme.slice(slash + 1);
}

/**
 * Map a dig-dns `.dig` host (§5.5 label form — a base32 store id, optionally a `<rootLabel>.<storeLabel>`
 * pinned pair, matching `open-urn`'s `buildDigSchemeUrl` label order) to a canonical `chia://` URL, or
 * `null` when the leftmost label(s) are NOT valid 52-char base32 store ids (i.e.
 * it's a human name, which is an on.dig.net shorthand instead — see {@link classifyDigInput}).
 */
function digDnsHostToChiaUrl(host: string, path: string): string | null {
  const labels = host.slice(0, -DIG_SUFFIX.length).split('.');
  if (labels.length === 1) {
    const store = digLabelToStoreHex(labels[0]);
    if (!store) return null;
    return `chia://${store}${path ? '/' + path : ''}`;
  }
  if (labels.length === 2) {
    // dig-dns pins as `<rootLabel>.<storeLabel>.dig` (leftmost = root); canonical URN = store:root.
    const root = digLabelToStoreHex(labels[0]);
    const store = digLabelToStoreHex(labels[1]);
    if (!root || !store) return null;
    return `chia://chia:${store}:${root}${path ? '/' + path : ''}`;
  }
  return null;
}

/**
 * Classify a raw entry-surface input into the shared DIG-navigation decision (#362). PURE (no
 * `chrome.*`/DOM/network) so every tier's routing is unit-tested from one place. Resolution of an
 * `on-dig-net` host to its URN needs a network `HEAD` (#308) and is done by the async
 * {@link resolveOnDigNetUrn} — this classifier only recognizes the form.
 */
export function classifyDigInput(raw: string | null | undefined): DigInputClass {
  const t = String(raw ?? '').trim();
  if (!t) return { kind: 'web', query: '' };

  const host = hostOf(t);
  const path = pathOf(t);

  // `.on.dig.net` (with or without a `chia://` prefix) → on-dig-net (HEAD→URN, #308). Checked before
  // `.dig` so `foo.on.dig.net` is never mistaken for a `.dig` host.
  if (host.endsWith(ON_DIG_NET_SUFFIX) && host.length > ON_DIG_NET_SUFFIX.length) {
    return { kind: 'on-dig-net', host };
  }

  // `.dig` host → either a dig-dns base32 store label (canonical urn) or a human name that is a
  // shorthand for `<name>.on.dig.net` (#308).
  if (host.endsWith(DIG_SUFFIX) && host.length > DIG_SUFFIX.length) {
    const chiaUrl = digDnsHostToChiaUrl(host, path);
    if (chiaUrl) return { kind: 'urn', chiaUrl };
    return { kind: 'on-dig-net', host: host.slice(0, -DIG_SUFFIX.length) + ON_DIG_NET_SUFFIX };
  }

  // `chia://` / `urn:dig:` / bare `<64hex>` (with optional `:root`, `/path`, `?salt=`) → the shared
  // URN grammar (`open-urn` → `parseURN`, one parser) → the canonical `chia://` URL.
  const parsed = parseOpenUrnInput(t);
  if (parsed) return { kind: 'urn', chiaUrl: buildContentViewUrl(parsed) };

  // Non-DIG. An explicit http(s) URL or a bare domain navigates; anything else is a web search.
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (!/\s/.test(t) && /^[^\s]+\.[^\s]{2,}([/?#].*)?$/.test(t)) return { kind: 'url', url: 'https://' + t };
  return { kind: 'web', query: t };
}

/** True when the input is a DIG address (a `urn` or an `on-dig-net` reference) — the DIG-vs-not test
 *  shared by the omnibox classifier (`apps.classifyOmnibox`) and the DIG search-provider resolver. */
export function isDigShapedInput(raw: string | null | undefined): boolean {
  const k = classifyDigInput(raw).kind;
  return k === 'urn' || k === 'on-dig-net';
}

/** The `X-Dig-URN` response header the on.dig.net resolver returns for a mapped subdomain (#308). */
export const X_DIG_URN_HEADER = 'X-Dig-URN';

/**
 * Resolve an `*.on.dig.net` subdomain to its canonical `chia://` URL by reading the resolver's
 * HEAD→URN contract (#308): `HEAD https://<host>/` returns `X-Dig-URN: urn:dig:chia:<storeId>[:<root>]`
 * for a mapped subdomain. Returns the canonical `chia://` URL (so the caller loads it through the
 * local-node `/s/` protocol via {@link chooseNavTarget}, NOT the on.dig.net CDN), or `null` when the
 * subdomain is unmapped, the header/URN is missing/malformed, or the request fails.
 *
 * `fetchImpl` is injectable so the network contract is unit-tested without a live resolver; in
 * production it MUST run from the extension origin (the SW / an extension page) so the `X-Dig-*`
 * CORS-exposed headers are readable and the request carries the extension's host permissions.
 */
export async function resolveOnDigNetUrn(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://${host}/`, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    const urn = res.headers.get(X_DIG_URN_HEADER);
    if (!urn) return null;
    const parsed = parseURN(urn);
    if (!parsed) return null;
    return buildContentViewUrl(parsed);
  } catch {
    return null;
  }
}
