/**
 * xchtip.app tip-button generator links (#380, part 3) — the PURE builders the Tip tab uses to give a
 * user a way for OTHERS to tip THEM in XCH. xchtip.app is the ecosystem's embeddable Chia tip-button
 * generator (#142/#185-188); every artifact below is a documented, backend-free, deterministic URL/
 * snippet we construct client-side (xchtip.app SPEC / `public/llms.txt`), so the extension never has to
 * call the site to produce them:
 *  - a ready-to-share hosted tip page (`/jar/<address>`) — the "hand this out so people tip me" link;
 *  - a pre-filled builder deep-link (`/?recipient=…&asset=xch`) — open to tweak/copy an embed;
 *  - a copyable `<script>` embed snippet a creator pastes into their own site.
 *
 * The recipient is the user's OWN XCH receive address (`getReceiveAddress`); we guard it with a
 * lightweight `xch1…` shape check (the address is already wallet-valid — this only stops building a
 * link from an empty/garbage value and keeps the snippet injection-free).
 */

/** xchtip.app production origin (root builder, no base path). */
export const XCHTIP_ORIGIN = 'https://xchtip.app';
/** The embeddable widget script path (xchtip.app SPEC `EMBED_PATH`). */
export const XCHTIP_EMBED_SRC = `${XCHTIP_ORIGIN}/embed/xch-tip.js`;

/** Optional presentation extras a caller may attach to a generated link. */
export interface XchtipOptions {
  /** A recipient display name shown on the tip page/button (sanitized by xchtip.app). */
  name?: string;
  /** Suggested amount presets, e.g. `[1, 5, 25]`. */
  presets?: number[];
  /** A custom button label. */
  label?: string;
}

/**
 * Lightweight `xch1…` address guard: a lowercase bech32m mainnet address is `xch1` + a data part.
 * Deliberately NOT a full bech32m checksum validation (that needs the wasm codec) — the address comes
 * from the wallet's own receive-address query, so this only rejects empty/garbage/wrong-prefix input.
 */
export function isXchAddress(address: string | null | undefined): boolean {
  return typeof address === 'string' && /^xch1[a-z0-9]{8,}$/.test(address);
}

/** Build a `?k=v` query string from defined, non-empty entries (URL-encoded), or `''` if none. */
function queryString(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 0) usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * The ready-to-share hosted tip page for the user's XCH address: `https://xchtip.app/jar/<address>`.
 * XCH is the default asset, so no `?asset`. A display `name` is appended when given. Returns null for a
 * non-address so the caller renders nothing rather than a broken link.
 */
export function xchtipJarUrl(address: string, opts: XchtipOptions = {}): string | null {
  if (!isXchAddress(address)) return null;
  const query = queryString({
    name: opts.name,
    presets: opts.presets?.length ? opts.presets.join(',') : undefined,
    label: opts.label,
  });
  return `${XCHTIP_ORIGIN}/jar/${address}${query}`;
}

/**
 * A builder deep-link pre-filled with the user's XCH address (`?recipient=…&asset=xch`) — opens the
 * xchtip.app builder so the user can tweak the button + copy the embed. Null for a non-address.
 */
export function xchtipBuilderUrl(address: string): string | null {
  if (!isXchAddress(address)) return null;
  return `${XCHTIP_ORIGIN}/?recipient=${address}&asset=xch`;
}

/**
 * A copyable one-line `<script>` embed snippet a creator pastes into their own site. The address is
 * guarded (so the interpolation has no injection surface). Null for a non-address.
 */
export function xchtipEmbedSnippet(address: string, opts: XchtipOptions = {}): string | null {
  if (!isXchAddress(address)) return null;
  const attrs = [
    `src="${XCHTIP_EMBED_SRC}"`,
    `data-recipient="${address}"`,
    `data-asset="xch"`,
  ];
  if (opts.presets?.length) attrs.push(`data-amount-presets="${opts.presets.join(',')}"`);
  if (opts.label) attrs.push(`data-label="${opts.label}"`);
  attrs.push('async');
  return `<script ${attrs.join(' ')}></script>`;
}
