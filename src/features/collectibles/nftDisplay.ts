/**
 * Pure presentation helpers for the Collectibles surface (#56) — display name, collection grouping,
 * royalty label, and CSP-safe image resolution. No wasm / no chrome.* / no React, so every branch is
 * unit-tested directly.
 *
 * Image/CSP note (#150): the extension's `img-src` CSP is `'self' data: https:` — `<img>` tags cannot
 * execute code, so embedding a remote host is not a script-injection risk; the real tradeoff is
 * PRIVACY (loading a remote image reveals the user's IP address to that host, exactly like every other
 * NFT wallet — Sage included — that renders art by default). Almost every real NFT stores its art on a
 * remote host (an IPFS gateway, a marketplace CDN, arweave), so an on-chain `data:` image is rendered
 * inline AND a remote `http(s)` image is now embedded too; a raw `ipfs://` URI is gateway-rewritten
 * (see {@link toGatewayUrl}) to a fetchable `https://` URL first, since browsers cannot dereference the
 * `ipfs://` scheme directly. The monogram placeholder is kept as an `onerror` FALLBACK in the `NftMedia`
 * component (`NftDetail.tsx`) for images that fail to load (dead gateway, broken/missing URL, offline
 * host) — the grid never shows a broken-image icon.
 */

import type { WalletNft } from '@/offscreen/nfts';

/** Shorten a hex id to `head…tail` for compact display (full value stays available on detail). */
export function shortHex(hex: string, head = 6, tail = 4): string {
  const h = hex.replace(/^0x/i, '');
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** A stable human label for an NFT (no on-chain name exists) — a shortened launcher id. */
export function nftDisplayName(nft: WalletNft): string {
  return shortHex(nft.launcherId, 6, 4);
}

/** The edition badge (`#n` or `#n of total`), or null for a lone 1/1 with no meaningful edition. */
export function editionLabel(nft: WalletNft): string | null {
  const n = nft.editionNumber;
  const total = nft.editionTotal;
  if ((total === '1' || total === '0' || total === '') && (n === '1' || n === '0' || n === '')) return null;
  return total && total !== '1' ? `#${n} of ${total}` : `#${n}`;
}

/** Royalty as a human percent (basis points ÷ 100), trimmed — e.g. 300 → "3%", 250 → "2.5%". */
export function royaltyPercentLabel(basisPoints: number): string {
  const pct = basisPoints / 100;
  const str = Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${str}%`;
}

const isDataUri = (uri: string): boolean => /^data:/i.test(uri.trim());
const isHttpUri = (uri: string): boolean => /^https?:\/\//i.test(uri.trim());
const isIpfsUri = (uri: string): boolean => /^ipfs:\/\//i.test(uri.trim());
/** A URI this module knows how to turn into a fetchable `https://` (or `data:`) image source. */
const isEmbeddableRemoteUri = (uri: string): boolean => isHttpUri(uri) || isIpfsUri(uri);

/**
 * Rewrite an `ipfs://<cid>/<path>` URI to a fetchable public HTTPS gateway URL
 * (`https://ipfs.io/ipfs/<cid>/<path>`); any other URI (already `http(s)`, `data:`, or an
 * unrecognized scheme) passes through unchanged.
 */
export function toGatewayUrl(uri: string): string {
  const trimmed = uri.trim();
  const m = /^ipfs:\/\/(.+)$/i.exec(trimmed);
  return m ? `https://ipfs.io/ipfs/${m[1]}` : trimmed;
}

/**
 * The image src to embed in an `<img>` under the extension's `img-src 'self' data: https:` CSP
 * (#150): the first `data:` URI embedded as-is, or the first remote `http(s)`/`ipfs://` URI
 * (gateway-rewritten so `ipfs://` is fetchable) — else null (no usable image; the caller shows the
 * monogram placeholder). Callers add an `onerror` fallback to the monogram for images that fail to
 * load at render time.
 */
export function nftImageSrc(nft: WalletNft): string | null {
  const uri = nft.dataUris[0];
  if (!uri) return null;
  const trimmed = uri.trim();
  if (isDataUri(trimmed)) return trimmed;
  if (isEmbeddableRemoteUri(trimmed)) return toGatewayUrl(trimmed);
  return null;
}

/**
 * The first remote (`http(s)`/`ipfs://`) image URI, gateway-rewritten, offered as an external
 * "view image" link (opens the original in a normal browser tab, outside the extension's tile size).
 */
export function nftExternalImageUrl(nft: WalletNft): string | null {
  const uri = nft.dataUris.find((u) => isEmbeddableRemoteUri(u));
  return uri ? toGatewayUrl(uri) : null;
}

/** A deterministic 2-char monogram (from the launcher id) for the placeholder tile. */
export function nftMonogram(nft: WalletNft): string {
  const h = nft.launcherId.replace(/^0x/i, '');
  return (h.slice(0, 2) || 'NF').toUpperCase();
}

/** One collection bucket: its id (a minter DID hex, or null = ungrouped) + the NFTs in it. */
export interface CollectionGroup {
  collectionId: string | null;
  nfts: WalletNft[];
}

/**
 * Group NFTs by their `collectionId` (the current-owner DID) — the on-chain signal for "same minter /
 * collection". Groups preserve first-seen order; the ungrouped bucket (collectionId === null) sorts
 * last so named collections lead.
 */
export function groupByCollection(nfts: WalletNft[]): CollectionGroup[] {
  const order: (string | null)[] = [];
  const byId = new Map<string | null, WalletNft[]>();
  for (const nft of nfts) {
    const id = nft.collectionId;
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(nft);
  }
  return order
    .sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0))
    .map((id) => ({ collectionId: id, nfts: byId.get(id)! }));
}
