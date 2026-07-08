/**
 * dexie.space marketplace integration (#102) — a thin client for the public `api.dexie.space` REST
 * API: post a self-custody offer for other wallets to discover, browse currently-open offers, and
 * resolve a dexie link/id to the underlying `offer1…` bytes for import. `dexie.space` is a Chia
 * offer AGGREGATOR, not a counterparty — the wallet's own offer bytes are already dexie-compatible
 * (the same `chia-sdk-driver` construction, #94/#100's module doc), so posting is a plain upload of
 * bytes the wallet already built; browsing/importing hands the raw bytes to the SAME `inspectOffer`/
 * `takeOffer` pipeline as a pasted offer — dexie's OWN decoded summary is NEVER trusted for the
 * actual take (fail-closed: this wallet always re-derives the two-sided summary from the raw bytes
 * itself via its own offer engine, exactly like a pasted/dropped offer).
 *
 * PURE (chrome.*-free): `fetchFn` is injected (the SW's global `fetch` at the call site), so this
 * module is fully unit-tested with a stubbed fetch. The manifest already grants `api.dexie.space`
 * in both `host_permissions` and the extension-pages CSP `connect-src` (pre-existing, confirmed live
 * against the real API — see DEVELOPMENT_LOG.md).
 *
 * Response shape confirmed against the LIVE `api.dexie.space/v1` API (no formal OpenAPI spec is
 * published): `{success, offer:{id,status,offer,date_found,offered:[{id,code,name,amount}],
 * requested:[...]}}` for a single offer, `{success,count,page,page_size,offers:[...]}` for a search,
 * `{success:false,error_message}` on a POST rejection. `amount` on EVERY dexie-side asset entry is
 * already a HUMAN-decimal number (e.g. `33.955` XCH) — dexie normalizes by the asset's own decimals
 * server-side; this is for DISPLAY only in the browse list, never fed into a spend (the actual take
 * re-decodes the raw offer bytes for real base-unit amounts, per the module doc above).
 */

const DEXIE_BASE = 'https://api.dexie.space/v1';

/** dexie's offer status codes (from the LIVE API's `status` field): 0 open, 1 pending, 2 cancelling,
 * 3 cancelled, 4 completed, 5 unknown, 6 expired. Exposed as a raw number — the browse UI only needs
 * to distinguish "open" (0) from everything else for now. */
export type DexieStatus = number;

/** One asset leg as dexie itself reports it — DISPLAY-only (see the module doc's amount caveat). */
export interface DexieAsset {
  id: string;
  code: string;
  name?: string;
  amount: number;
}

/** One dexie-indexed offer, mapped from the API's snake_case fields to this module's own shape. */
export interface DexieOfferSummary {
  id: string;
  /** The real `offer1…` bytes — fed into this wallet's OWN `inspectOffer`/`takeOffer`, never dexie's
   * own decoded `offered`/`requested` (display-only, see the module doc). */
  offerStr: string;
  status: DexieStatus;
  dateFound: string;
  offered: DexieAsset[];
  requested: DexieAsset[];
}

/** The minimal `fetch`-shaped surface this module needs, injected by the caller (the SW's global
 * `fetch` at runtime; a stub in tests). Deliberately narrower than the DOM `fetch` type so a test
 * double doesn't need to implement the full `Response` interface. */
export type DexieFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Narrow an unknown JSON value's field, defaulting when absent/wrong-typed — dexie's API has no
 * published schema, so every field read here is defensive. */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function assetOf(v: unknown): DexieAsset {
  const o = (v ?? {}) as Record<string, unknown>;
  return { id: str(o.id), code: str(o.code, str(o.id)), name: typeof o.name === 'string' ? o.name : undefined, amount: num(o.amount) };
}
function assetsOf(v: unknown): DexieAsset[] {
  return Array.isArray(v) ? v.map(assetOf) : [];
}

/** Map one raw dexie offer object (the shape embedded in both the single-offer GET and the search
 * response) to this module's {@link DexieOfferSummary}. */
function toSummary(raw: unknown): DexieOfferSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    offerStr: str(o.offer),
    status: num(o.status, 5),
    dateFound: str(o.date_found),
    offered: assetsOf(o.offered),
    requested: assetsOf(o.requested),
  };
}

/**
 * Extract a dexie offer id from either a full `https://dexie.space/offers/<id>` URL or a bare id.
 * Returns `null` for anything that looks like a raw `offer1…` string (not a dexie reference) or
 * garbage input — the caller uses this to decide whether pasted Take input needs a dexie resolve
 * step before the normal `offer1…` validation.
 */
export function extractDexieOfferId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const urlMatch = /dexie\.space\/offers\/([A-Za-z0-9]+)/i.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  if (trimmed.startsWith('offer1')) return null; // a raw offer string, not a dexie reference
  return /^[A-Za-z0-9]{8,}$/.test(trimmed) ? trimmed : null;
}

/**
 * POST this wallet's already-built offer bytes to dexie so other wallets can discover it. Returns
 * dexie's own id for the listing (`known:true` when dexie had already indexed this exact offer —
 * e.g. a re-post after the extension restarted). Throws `DEXIE_POST_FAILED: <reason>` on rejection
 * or a network-level failure; never partially succeeds.
 */
export async function postOfferToDexie(fetchFn: DexieFetch, offerStr: string): Promise<{ id: string; known: boolean }> {
  let data: unknown;
  try {
    const res = await fetchFn(`${DEXIE_BASE}/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer: offerStr }),
    });
    data = await res.json();
  } catch (e) {
    throw new Error(`DEXIE_POST_FAILED: ${e instanceof Error ? e.message : 'network error'}`);
  }
  const o = (data ?? {}) as Record<string, unknown>;
  if (o.success !== true) {
    throw new Error(`DEXIE_POST_FAILED: ${str(o.error_message, 'dexie rejected the offer')}`);
  }
  return { id: str(o.id), known: o.known === true };
}

/**
 * Resolve a dexie link/id (see {@link extractDexieOfferId}) to its underlying offer summary — the
 * `offerStr` is then fed into this wallet's OWN `inspectOffer`, never dexie's decoded fields (module
 * doc). Returns `null` for non-dexie input, an unknown id, or any network/parse failure — the caller
 * falls back to treating the input as a plain (possibly invalid) `offer1…` string.
 */
export async function fetchDexieOffer(fetchFn: DexieFetch, idOrUrl: string): Promise<DexieOfferSummary | null> {
  const id = extractDexieOfferId(idOrUrl);
  if (!id) return null;
  try {
    const res = await fetchFn(`${DEXIE_BASE}/offers/${id}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.success !== true || !data.offer) return null;
    return toSummary(data.offer);
  } catch {
    return null;
  }
}

/** Search parameters for {@link searchDexieOffers} — asset filters are dexie's own `code`/id
 * strings (e.g. `'xch'`, a CAT asset id, or a ticker code dexie recognizes). */
export interface DexieSearchParams {
  offered?: string;
  requested?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Browse currently-OPEN offers on dexie (status `0`), optionally filtered by offered/requested
 * asset. Returns `[]` — never throws — on a failed/malformed response or a network failure, so a
 * flaky dexie read degrades to an empty browse list rather than crashing the Take flow.
 */
export async function searchDexieOffers(fetchFn: DexieFetch, params: DexieSearchParams = {}): Promise<DexieOfferSummary[]> {
  const qs = new URLSearchParams();
  qs.set('status', '0');
  if (params.offered) qs.set('offered', params.offered);
  if (params.requested) qs.set('requested', params.requested);
  qs.set('page', String(params.page ?? 1));
  qs.set('page_size', String(params.pageSize ?? 20));
  try {
    const res = await fetchFn(`${DEXIE_BASE}/offers?${qs.toString()}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.success !== true || !Array.isArray(data.offers)) return [];
    return data.offers.map(toSummary);
  } catch {
    return [];
  }
}
