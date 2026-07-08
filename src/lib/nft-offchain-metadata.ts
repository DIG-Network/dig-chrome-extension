/**
 * CHIP-0007 off-chain metadata JSON — parsing only (#98). An NFT's on-chain metadata program
 * carries pointers (`metadataUris`/`metadataHash`, `src/offscreen/nfts.ts`) to a small JSON
 * document hosted off-chain (an IPFS gateway, a marketplace CDN, arweave) that holds the fields a
 * human actually wants to see: the real name, description, trait attributes, and the collection it
 * belongs to. Nothing in this extension parsed that document before #98 — the gallery only ever had
 * the shortened launcher id (`nftDisplayName`, `nftDisplay.ts`) and the owner-DID hex as a stand-in
 * collection label (`groupByCollection`).
 *
 * The wire shape mirrors the CHIP-0007 spec exactly (snake_case on the wire — the SAME shape
 * `chip35_dl_coin`'s `Chip0007Metadata`/`CollectionRef`/`CollectionAttribute` Rust types model for
 * MINTING, kept here as the read-side counterpart so the ecosystem agrees on one schema):
 *
 * ```json
 * {
 *   "format": "CHIP-0007",
 *   "name": "...",
 *   "description": "...",
 *   "minting_tool": "...",
 *   "sensitive_content": false,
 *   "series_number": 1,
 *   "series_total": 1,
 *   "attributes": [{ "trait_type": "...", "value": "..." }],
 *   "collection": { "id": "...", "name": "...", "attributes": [{ "type": "...", "value": "..." }] }
 * }
 * ```
 *
 * `collection.attributes[].type` is the current CHIP-0007 field name; `chip35_dl_coin`'s
 * "collection-attr type fix" (#189) also accepts the legacy `trait_type` key some older minted
 * documents used for the SAME field — {@link parseNftOffchainMetadata} accepts both, matching that
 * fix, so this extension reads every document `chip35_dl_coin` can mint.
 *
 * `raw` is UNTRUSTED third-party content served by an arbitrary host the on-chain metadata URI
 * happens to point at — {@link parseNftOffchainMetadata} never throws on garbage, only pulls known
 * string/array fields, and caps every string length + the attribute-array length so a hostile or
 * malformed document can't blow up a render or exhaust memory. A document with none of the fields
 * this module understands parses to `null` (the caller falls back to on-chain-only display, exactly
 * like an NFT with no off-chain metadata at all).
 */

/** One item-level trait (`attributes[]`) — e.g. `{ traitType: 'Background', value: 'Blue' }`. */
export interface NftAttribute {
  traitType: string;
  value: string;
}

/** One collection-level attribute (`collection.attributes[]`) — e.g. a royalty note or a banner ref. */
export interface NftCollectionAttribute {
  type: string;
  value: string;
}

/** The `collection` object — the off-chain name/id CHIP-0007 uses to group NFTs from the same drop. */
export interface NftCollectionRef {
  id: string | null;
  name: string | null;
  attributes: NftCollectionAttribute[];
}

/** A parsed, size-capped CHIP-0007 off-chain metadata document. */
export interface NftOffchainMetadata {
  format: string | null;
  name: string | null;
  description: string | null;
  sensitiveContent: boolean;
  attributes: NftAttribute[];
  collection: NftCollectionRef | null;
  seriesNumber: number | null;
  seriesTotal: number | null;
  mintingTool: string | null;
}

const MAX_SHORT_STRING = 200;
const MAX_DESCRIPTION = 4000;
const MAX_ATTRIBUTES = 100;

/** A trimmed, length-capped string, or null for anything that isn't a non-empty string. */
function safeString(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** A trait/attribute `value` may legally be a JSON string OR number (CHIP-0007 allows either). */
function safeAttributeValue(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return safeString(v, MAX_SHORT_STRING);
}

function parseAttributes(raw: unknown): NftAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: NftAttribute[] = [];
  for (const entry of raw.slice(0, MAX_ATTRIBUTES)) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const traitType = safeString(obj.trait_type, MAX_SHORT_STRING);
    const value = safeAttributeValue(obj.value);
    if (traitType && value) out.push({ traitType, value });
  }
  return out;
}

function parseCollectionAttributes(raw: unknown): NftCollectionAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: NftCollectionAttribute[] = [];
  for (const entry of raw.slice(0, MAX_ATTRIBUTES)) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    // #189's fix: `type` is current, `trait_type` is the legacy key for the SAME field — accept both.
    const type = safeString(obj.type, MAX_SHORT_STRING) ?? safeString(obj.trait_type, MAX_SHORT_STRING);
    const value = safeAttributeValue(obj.value);
    if (type && value) out.push({ type, value });
  }
  return out;
}

function parseCollection(raw: unknown): NftCollectionRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = safeString(obj.id, MAX_SHORT_STRING);
  const name = safeString(obj.name, MAX_SHORT_STRING);
  const attributes = parseCollectionAttributes(obj.attributes);
  if (!id && !name && attributes.length === 0) return null;
  return { id, name, attributes };
}

/** A JSON `series_number`/`series_total` value, or null for anything not a positive finite integer. */
function safeSeries(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

/**
 * Decode a `data:` URI's payload as JSON (base64 or percent-encoded/raw text) — used when
 * {@link nftMetadataUri} (`nftDisplay.ts`) resolves an inline `data:` metadata document, which needs
 * no network fetch. Returns `null` for anything that isn't a well-formed `data:` URI, invalid
 * base64, or invalid JSON — never throws.
 */
export function decodeDataUriJson(uri: string): unknown | null {
  const m = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!m) return null;
  const [, meta, payload] = m;
  try {
    const text = /;base64$/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse an untrusted, already-JSON-decoded off-chain metadata document into a size-capped
 * {@link NftOffchainMetadata}, or `null` when `raw` isn't an object or carries none of the fields
 * this module understands (nothing usable to show).
 */
export function parseNftOffchainMetadata(raw: unknown): NftOffchainMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const format = safeString(obj.format, 40);
  const name = safeString(obj.name, MAX_SHORT_STRING);
  const description = safeString(obj.description, MAX_DESCRIPTION);
  const sensitiveContent = obj.sensitive_content === true;
  const attributes = parseAttributes(obj.attributes);
  const collection = parseCollection(obj.collection);
  const seriesNumber = safeSeries(obj.series_number);
  const seriesTotal = safeSeries(obj.series_total);
  const mintingTool = safeString(obj.minting_tool, MAX_SHORT_STRING);

  if (!name && !description && attributes.length === 0 && !collection) return null;

  return { format, name, description, sensitiveContent, attributes, collection, seriesNumber, seriesTotal, mintingTool };
}
