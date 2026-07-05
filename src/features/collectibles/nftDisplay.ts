/**
 * Pure presentation helpers for the Collectibles surface (#56) — display name, collection grouping,
 * royalty label, and CSP-safe image resolution. No wasm / no chrome.* / no React, so every branch is
 * unit-tested directly.
 *
 * Image/CSP note: the extension's `img-src` CSP allows only `'self' data: https://explore.dig.net`,
 * so an arbitrary remote NFT image URL (IPFS gateway, marketplace CDN) CANNOT be embedded — doing so
 * would require widening the CSP, a security regression. Therefore: an on-chain `data:` image is
 * rendered inline (inert, CSP-allowed); a remote `http(s)` image is NOT embedded — a deterministic
 * monogram placeholder is shown instead and the URL is offered as an external "view image" link.
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

/**
 * The image src safe to embed in an `<img>` under the extension CSP: the first `data:` data URI, else
 * null (remote images are blocked — the caller shows a monogram placeholder + an external link).
 */
export function nftImageSrc(nft: WalletNft): string | null {
  const uri = nft.dataUris[0];
  return uri && isDataUri(uri) ? uri.trim() : null;
}

/** The first remote (`http(s)`) data URI, offered as an external "view image" link (never embedded). */
export function nftExternalImageUrl(nft: WalletNft): string | null {
  const uri = nft.dataUris.find((u) => isHttpUri(u));
  return uri ? uri.trim() : null;
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
