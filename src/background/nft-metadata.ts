// -----------------------------------------------------------------------------------------------
// NFT OFF-CHAIN METADATA FETCH (#98) — extracted from the frozen service-worker monolith
// (`src/background/index.ts`) into this SEPARATE, FULLY-TYPED module (#1945, mirroring the #1464
// `app-sign-handlers.ts` / the #1945 `search-engine.ts` extractions).
//
// The SW monolith carries a justified file-level `// @ts-nocheck` (behaviour-frozen chrome.* glue
// relocated in #68); that carve-out was also swallowing NEW handlers added since the freeze, this
// one among them. This module lifts the metadata fetch OUT of the frozen surface so it is
// type-checked and strict-linted like the rest of the codebase (§6.4). The SW's `getNftMetadata`
// message branch imports {@link fetchNftMetadataJson}; behaviour is byte-for-byte the pre-extraction
// path.
// -----------------------------------------------------------------------------------------------

/** Reject a metadata document larger than this before parsing it (200 KB). */
const NFT_METADATA_MAX_BYTES = 200 * 1024;
/** Abort the fetch after this long — third-party hosts must not hang the SW (8s). */
const NFT_METADATA_TIMEOUT_MS = 8000;

/** Machine-readable failure codes the caller keys its handling off (§6.2). */
export type NftMetadataErrorCode =
  | 'BAD_REQUEST'
  | 'FETCH_FAILED'
  | 'TOO_LARGE'
  | 'INVALID_JSON'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

/**
 * The result shape of {@link fetchNftMetadataJson}: on success the RAW decoded JSON under
 * `metadata` (the caller validates/shapes it); on failure a `{ success: false, code, message }`
 * envelope. Byte-identical to the pre-extraction handler's return shape.
 */
export type NftMetadataResult =
  | { metadata: unknown }
  | { success: false; code: NftMetadataErrorCode; message: string };

/**
 * Fetch + JSON-decode the off-chain CHIP-0007 metadata document at `uri` (#98). Handled in the
 * service worker itself (not the offscreen vault/document) as a simple, no-vault-dependency read,
 * matching the other non-custody SW actions (`getDigDnsStatus`, `getVerification`, …).
 *
 * `metadataUris` are arbitrary third-party hosts (IPFS gateways, marketplace CDNs) the extension
 * cannot enumerate in advance. **A real gotcha, found empirically (`DEVELOPMENT_LOG.md`):** it was
 * assumed a Manifest V3 background service worker's own `fetch()` is NOT subject to the
 * extension-pages CSP `connect-src` directive (whose name suggests it governs only extension HTML
 * documents — popup/options/offscreen). That assumption was WRONG in practice: a `getNftMetadata`
 * call to a host outside `connect-src` failed with a network error and the request never even
 * reached the network layer — the signature of a CSP block. `connect-src` (and `host_permissions`,
 * for the CORS-bypass fetch elevation — most off-chain metadata hosts won't send
 * `Access-Control-Allow-Origin`) had to be widened to `https:` / an all-hosts pattern
 * (`manifest.json`), matching the breadth `img-src` already grants NFT art (§18.11 SPEC.md).
 *
 * GET-only, time-capped, and rejects an oversized response before ever attempting to parse it.
 * Returns the RAW decoded JSON — the caller (`parseNftOffchainMetadata`,
 * `src/lib/nft-offchain-metadata.ts`) validates/shapes it, since this is untrusted third-party
 * content, not something this handler should interpret.
 */
export async function fetchNftMetadataJson(uri: unknown): Promise<NftMetadataResult> {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) {
    return { success: false, code: 'BAD_REQUEST', message: 'metadata uri must be http(s)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NFT_METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { signal: controller.signal });
    if (!res.ok) return { success: false, code: 'FETCH_FAILED', message: `HTTP ${res.status}` };
    const text = await res.text();
    if (text.length > NFT_METADATA_MAX_BYTES) {
      return { success: false, code: 'TOO_LARGE', message: 'metadata document too large' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { success: false, code: 'INVALID_JSON', message: 'not valid JSON' };
    }
    return { metadata: json };
  } catch (e) {
    // Match the pre-extraction behaviour EXACTLY: an aborted fetch rejects with a DOMException,
    // which is not reliably `instanceof Error`, so detect the timeout by NAME (not via instanceof);
    // and prefer the error's own message, falling back to String(e) when it's empty/absent.
    const err = e as { name?: unknown; message?: unknown } | null | undefined;
    const aborted = !!err && err.name === 'AbortError';
    const message = String((err && err.message) || e);
    return { success: false, code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', message };
  } finally {
    clearTimeout(timer);
  }
}
