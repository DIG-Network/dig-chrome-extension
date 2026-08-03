// -----------------------------------------------------------------------------------------------
// DEXIE MARKETPLACE INTEGRATION (#102) — SW-side glue over the pure `src/lib/dexie.ts` client,
// extracted from the frozen service-worker monolith (`src/background/index.ts`) into this SEPARATE,
// FULLY-TYPED module (#1945, mirroring the #1464 app-sign / #157 search-engine / #158 nft-metadata
// extractions).
//
// NOT custody actions (no wallet key involved): posting an already-built offer, browsing dexie's
// public listing, and resolving a dexie link/id are all plain fetches — handled here exactly like
// the NFT-metadata fetch (`api.dexie.space` is pre-granted in both `host_permissions` and the
// extension-pages CSP `connect-src`, confirmed live). Lifting them OUT of the frozen `@ts-nocheck`
// surface so they are type-checked and strict-linted like the rest of the codebase (§6.4); the SW's
// `dexiePost`/`dexieBrowse`/`dexieResolve` message branches import these. Behaviour byte-for-byte the
// pre-extraction path.
// -----------------------------------------------------------------------------------------------

import {
  postOfferToDexie,
  fetchDexieOffer,
  searchDexieOffers,
  type DexieOfferSummary,
} from '@/lib/dexie';

/** `handleDexiePost` result: the dexie id + whether the offer was already known, or a coded error. */
export type DexiePostResult =
  | { success: true; dexieId: string; known: boolean }
  | { success: false; code: string; message: string };

/** `handleDexieResolve` result: the resolved offer summary (`null` if not found), or a coded error. */
export type DexieResolveResult =
  | { offer: DexieOfferSummary | null }
  | { success: false; code: string; message: string };

/** Post an already-built offer string to dexie. Validates the `offer1…` prefix; on failure returns
 *  the leading `CODE:` prefix of the client error message as `code`, else `DEXIE_POST_FAILED`. */
export async function handleDexiePost(offer: unknown): Promise<DexiePostResult> {
  if (typeof offer !== 'string' || !offer.startsWith('offer1')) {
    return { success: false, code: 'BAD_REQUEST', message: 'offer string required' };
  }
  try {
    const { id, known } = await postOfferToDexie(fetch, offer);
    return { success: true, dexieId: id, known };
  } catch (e) {
    const err = e as { message?: unknown } | null | undefined;
    const msg = err && err.message ? String(err.message) : 'dexie post failed';
    const codeMatch = /^([A-Z][A-Z0-9_]*):/.exec(msg);
    return { success: false, code: codeMatch ? codeMatch[1] : 'DEXIE_POST_FAILED', message: msg };
  }
}

/** Browse currently-open dexie offers, optionally filtered by offered/requested asset. Returns
 *  `{ offers }` — `searchDexieOffers` degrades a failed/malformed read to `[]` rather than throwing. */
export async function handleDexieBrowse(
  offered?: string,
  requested?: string,
): Promise<{ offers: DexieOfferSummary[] }> {
  const offers = await searchDexieOffers(fetch, {
    ...(offered ? { offered } : {}),
    ...(requested ? { requested } : {}),
  });
  return { offers };
}

/** Resolve a dexie id or share URL to its offer summary. Returns `{ offer }` (`null` if not found). */
export async function handleDexieResolve(idOrUrl: unknown): Promise<DexieResolveResult> {
  if (typeof idOrUrl !== 'string' || idOrUrl.length === 0) {
    return { success: false, code: 'BAD_REQUEST', message: 'idOrUrl required' };
  }
  const offer = await fetchDexieOffer(fetch, idOrUrl);
  return { offer };
}
