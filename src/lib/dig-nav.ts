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
