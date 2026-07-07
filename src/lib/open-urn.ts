/**
 * #172 — open-by-URN/`chia://` decision core for the Home screen input.
 *
 * PURE (no `chrome.*`/DOM) so the branch logic is unit-testable without mocking the browser; the
 * React widget (src/features/home/OpenByUrnInput.tsx) performs the actual navigation this module
 * decides on.
 *
 * Validation reuses the SINGLE shared `parseURN` (SPEC.md §4 grammar, src/lib/dig-urn.ts) — no
 * second parser. The render-target decision follows the dig-dns-detect branch from the issue's
 * clarifying comments: read the shared dig-dns availability signal (src/lib/dig-dns.ts, exposed via
 * the `getDigDnsStatus` action / `useGetDigDnsStatusQuery` — NEVER re-probed here) and:
 *
 *   - phase `direct` or `proxy` (dig-dns is reachable, the proxy self-heal fallback counts too) ->
 *     navigate to the native `.dig`-scheme URL (`http://<storeLabel>.dig/<path>`, or the pinned
 *     `http://<rootLabel>.<storeLabel>.dig/<path>` for a rooted URN) — a real, portable, bookmarkable
 *     address, resolved machine-wide by dig-dns.
 *   - phase `unavailable` (or no signal yet) -> fall back to the extension's own
 *     `chrome-extension://` content view: hand the canonical `chia://` URL to the background
 *     `navigateToDigUrl` action, which redirects the active tab to `dig-viewer.html` — the existing
 *     §5.3 node-ladder (dig-node -> rpc.dig.net) read, verified + decrypted, rendered in-page (the
 *     SAME mechanism the Resolver tab and DIG Home omnibox already use for chia:// resolution).
 */
import { parseURN, type ParsedUrn } from '@/lib/dig-urn';
import { buildDigUrl } from '@/lib/store-refs';
import { storeHexToDigLabel } from '@/lib/dig-dns-host';
import type { DigDnsPhase } from '@/lib/dig-dns';

/**
 * Parse + light-validate a URN/`chia://` address a user typed (shape only — no network access).
 * Trims surrounding whitespace; delegates entirely to the shared `parseURN` (§4 grammar), so
 * anything it accepts (a `chia://` URL, a `urn:dig:` URN, a bare `<chain>:<storeId>[...]`, or a
 * chainless 64-hex store id, each with an optional `?salt=`) is accepted here too. `null` for
 * anything that doesn't parse, or for empty/whitespace-only input.
 */
export function parseOpenUrnInput(raw: string): ParsedUrn | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  return parseURN(trimmed);
}

/** Where a valid, parsed URN should be opened. */
export type OpenUrnTarget =
  | { kind: 'dig-scheme'; url: string }
  | { kind: 'content-view'; url: string };

/**
 * Build the native `.dig`-scheme URL for a parsed URN: `http://<storeLabel>.dig/<path>` for the
 * latest capsule, or the pinned `http://<rootLabel>.<storeLabel>.dig/<path>` when the URN pins a
 * specific root (leftmost label = the pinned root, matching dig-dns `host.rs`'s `HostTarget::Pinned`
 * label order). Returns `null` only defensively — `parseURN` already guarantees 64-hex ids, so
 * `storeHexToDigLabel` cannot actually fail here.
 */
export function buildDigSchemeUrl(parsed: ParsedUrn): string | null {
  const storeLabel = storeHexToDigLabel(parsed.storeId);
  if (!storeLabel) return null;
  const path = parsed.resourceKey ? `/${parsed.resourceKey}` : '/';
  if (parsed.roothash) {
    const rootLabel = storeHexToDigLabel(parsed.roothash);
    if (!rootLabel) return null;
    return `http://${rootLabel}.${storeLabel}.dig${path}`;
  }
  return `http://${storeLabel}.dig${path}`;
}

/**
 * The canonical, chain-prefixed `chia://` URL for a parsed URN — what the background
 * `navigateToDigUrl` action (and `proxyRequest` beneath it) expects. Reuses `buildDigUrl`
 * (src/lib/store-refs.ts), the same builder the in-page interceptor uses for same-capsule reads, so
 * there is one canonicalizer for this shape, not a second copy.
 */
export function buildContentViewUrl(parsed: ParsedUrn): string {
  return buildDigUrl({
    storeId: parsed.storeId,
    root: parsed.roothash,
    resourceKey: parsed.resourceKey,
    salt: parsed.salt,
  });
}

/**
 * Choose the render target for a parsed URN given the shared dig-dns availability phase. Any phase
 * OTHER than `unavailable` (`direct` or `proxy`) means dig-dns is reachable, so the machine-wide
 * `.dig` scheme is viable; `unavailable` — or no signal at all yet (`null`/`undefined`) —
 * conservatively falls back to the in-extension content view, which always works regardless of
 * dig-dns.
 */
export function resolveOpenTarget(parsed: ParsedUrn, digDnsPhase: DigDnsPhase | null | undefined): OpenUrnTarget {
  if (digDnsPhase && digDnsPhase !== 'unavailable') {
    const digUrl = buildDigSchemeUrl(parsed);
    if (digUrl) return { kind: 'dig-scheme', url: digUrl };
  }
  return { kind: 'content-view', url: buildContentViewUrl(parsed) };
}
