/**
 * DIG Network URN Utilities
 * Centralized module for URN parsing, encoding, and URL conversion
 */

/** A parsed Digstore URN; a null `roothash` references the store's latest capsule. */
export interface ParsedUrn {
  chain: string;
  storeId: string;
  roothash: string | null;
  resourceKey: string;
  salt: string | null;
}

// Base36 encoding/decoding for store IDs (64 hex chars -> max 50 base36 chars)
function hexToInt(hex: string): bigint {
  try {
    return BigInt('0x' + hex);
  } catch {
    throw new Error(`Invalid hex string: ${hex}`);
  }
}

function intToBase36(bigInt: bigint): string {
  if (bigInt === 0n) return '0';
  let result = '';
  const base = 36n;
  while (bigInt > 0n) {
    const remainder = Number(bigInt % base);
    const char = remainder < 10 
      ? remainder.toString()
      : String.fromCharCode(97 + remainder - 10); // 'a' = 97
    result = char + result;
    bigInt = bigInt / base;
  }
  return result;
}

function base36ToInt(base36: string): bigint {
  let result = 0n;
  const base = 36n;
  for (let i = 0; i < base36.length; i++) {
    const char = base36[i].toLowerCase();
    let digit;
    if (char >= '0' && char <= '9') {
      digit = BigInt(parseInt(char, 10));
    } else if (char >= 'a' && char <= 'z') {
      digit = BigInt(char.charCodeAt(0) - 97 + 10);
    } else {
      throw new Error(`Invalid base36 character: ${char}`);
    }
    result = result * base + digit;
  }
  return result;
}

function intToHex(bigInt: bigint, length = 64): string {
  const hex = bigInt.toString(16);
  return hex.padStart(length, '0');
}

/**
 * Encode store ID (64 hex chars) to base36 (max 50 chars)
 * @param {string} storeId - 64-character hexadecimal store ID
 * @returns {string} Base36 encoded store ID
 */
function encodeStoreId(storeId: string): string {
  if (!/^[a-f0-9]{64}$/i.test(storeId)) {
    throw new Error('Invalid store ID format');
  }
  const int = hexToInt(storeId);
  return intToBase36(int);
}

/**
 * Decode base36 to store ID (64 hex chars)
 * @param {string} encoded - Base36 encoded store ID
 * @returns {string} 64-character hexadecimal store ID
 */
function decodeStoreId(encoded: string): string {
  const int = base36ToInt(encoded);
  return intToHex(int, 64);
}

/**
 * Fully URL-decode a URN read from a query parameter.
 *
 * The dig-viewer receives the URN as `?urn=<value>` and reads it with `URLSearchParams`, which
 * decodes exactly ONCE. But several navigation entry points (address bar, link click, the
 * `chia://` protocol-error path, the search/omnibox redirect) can hand the background a
 * percent-encoded `chia://` URL, which is then `encodeURIComponent`'d AGAIN into the viewer URL —
 * so after the single `URLSearchParams` decode the value is still `chia%3A%2F%2F…` and `parseURN`
 * rejects it (the page appears to "not load"). This decodes percent-escapes until the value is
 * stable, recovering the real URN regardless of how many times it was encoded.
 *
 * SAFE by construction: a well-formed DIG URN contains NO literal `%`, so decoding only continues
 * while a `%XX` escape remains — it can never corrupt a valid URN. Bounded iterations + a guarded
 * `decodeURIComponent` mean malformed input (e.g. a lone `%`) is returned unchanged, never thrown.
 *
 * @param {string} raw - the (possibly multiply-encoded) urn param value
 * @returns {string} the fully-decoded URN (empty string for non-string input)
 */
function decodeUrnParam(raw: string | null | undefined): string {
  let v = typeof raw === 'string' ? raw : '';
  for (let i = 0; i < 5 && /%[0-9a-fA-F]{2}/.test(v); i++) {
    let dec;
    try {
      dec = decodeURIComponent(v);
    } catch {
      break; // malformed escape (e.g. a lone '%') — leave the value as-is
    }
    if (dec === v) break; // stable — nothing more to decode
    v = dec;
  }
  return v;
}

// THE PARAMETER NAME. Case-SENSITIVE, deliberately: `?SALT=ff00ff00` is an ordinary resource key,
// not a salt. Matching it case-insensitively (as this file once did) both strips a working key and
// reads a salt the contract says is not there — two different derived keys for one URN.
const SALT_PARAM_NAME = 'salt=';

// The literal the SPLIT decision scans for: a salt parameter introduced by an `&`. The other way a
// tail can qualify — `salt=` at the very start of the query — is tested with `startsWith` against
// the ORIGINAL string, because the split loop must never materialise a tail per candidate `?`.
const SALT_AFTER_AMP = `&${SALT_PARAM_NAME}`;

// The salt VALUE, read from a tail ALREADY judged to be a query. The hex class terminates the value
// at the first non-hex character, so a trailing `&next=…` or `#fragment` ends it, and an empty or
// valueless `salt` matches nothing and yields null.
//
// ITS SEPARATOR SET (`^`, `&`, `?`) IS DELIBERATELY WIDER THAN THE SPLIT'S (`^`, `&`) — do not
// unify them, in either direction. They answer different questions:
//
//   • the SPLIT asks "does this `?` START the query?", and only a `salt=`/`&salt=` may answer yes.
//     Widening it to `?` would make `report?year=2024.csv?salt=ff` qualify at its FIRST `?` and
//     truncate a real, already-published key back to `report`.
//   • this asks "where is the salt INSIDE the query?" — and once a `?` has been judged to start the
//     query, every later `?` is inside it and is a separator. Narrowing it to `&` derives NO salt
//     for `a?salt=zz?salt=ff00ff00`, which is silently undecryptable.
//
// The authority for both is the shared conformance table (see `urn-conformance.test.ts`).
const SALT_QUERY_VALUE_RE = new RegExp(`(?:^|[&?])${SALT_PARAM_NAME}([0-9a-fA-F]+)`);

/**
 * Split a URN string into its query-free base and the `salt` its query carried, if any.
 *
 * The salt is a QUERY PARAMETER, so it is read as one: at any position, with the rest of the query
 * discarded because no other parameter addresses a resource. Values are never percent-decoded — a
 * `%61%61` is not the hex `aa`, and reading it as one derives a different decryption key.
 *
 * Only a query is removed. Everything before the winning `?` — INCLUDING a `#` — is the resource
 * key, because a store key may literally contain `#` (`notes#1.md` is a real working key).
 *
 * LINEAR, deliberately. The obvious form of this loop takes `s.slice(at + 1)` per candidate `?` —
 * an O(n) copy plus a full regex scan, i.e. quadratic. dig-sdk measured a 195 KiB adversarial input
 * blocking its event loop for 2.1 s; this parser reads omnibox and content-script input, so the
 * same argument binds here. The tail is materialised exactly once, for the `?` that won.
 *
 * `ampIdx` MOVES FORWARD rather than being computed once: on `k&salt=?&salt=` the only `&salt=`
 * before the second `?` sits BEHIND it and must not qualify it. Re-searching only when the index
 * falls behind keeps the scans disjoint, so the whole loop stays linear.
 */
function splitQuery(s: string): { base: string; salt: string | null } {
  let ampIdx = s.indexOf(SALT_AFTER_AMP);
  for (let at = s.indexOf('?'); at >= 0; at = s.indexOf('?', at + 1)) {
    if (ampIdx >= 0 && ampIdx < at) ampIdx = s.indexOf(SALT_AFTER_AMP, at);
    // THE CONDITIONAL SPLIT — the whole point of this function, and the line a future
    // simplification would silently regress. A `?` is a LEGAL character in a resource key, so a
    // tail is a query ONLY when it carries a salt parameter at a boundary. The unconditional
    // `.replace(/\?.*$/, '')` this replaced truncated `report?year=2024.csv` to `report` and
    // `data?desalt=9.json` to `data` — real, working, already-published keys whose content then
    // became unreadable under a retrieval key that no longer matched the published one.
    //
    // Presence of the PARAMETER, not of a usable hex VALUE, governs the split: that keeps the
    // split decision independent of the value alphabet, including a malformed one, so the key is
    // derived from the same base either way. Whether the value is a usable salt is the separate
    // question SALT_QUERY_VALUE_RE answers.
    const isQuery = s.startsWith(SALT_PARAM_NAME, at + 1) || ampIdx > at;
    if (!isQuery) continue;
    // The FIRST qualifying `?` wins, not the last, because it strips the most: on
    // `a?salt=aa?salt=bb` the whole tail goes. Splitting at the last would leave `a?salt=aa` inside
    // `resourceKey` and derive a key the contract does not name.
    const m = SALT_QUERY_VALUE_RE.exec(s.slice(at + 1));
    return { base: s.slice(0, at), salt: m ? m[1].toLowerCase() : null };
  }
  return { base: s, salt: null };
}

/**
 * Percent-encode the characters that a URL would otherwise read as structure.
 *
 * A resource key may legitimately contain `#` (`notes#1.md`) and, since the conditional split
 * above, `?` (`report?year=2024.csv`). Pasted raw into a content-server URL those become a fragment
 * and a query — so the server would resolve a DIFFERENT resource than the one whose retrieval and
 * decryption keys were derived from the key. `/` is left intact: it is the key's own path
 * separator and is structural in the same way on both sides.
 *
 * RESIDUAL AMBIGUITY, deliberately not solved here: a key containing a literal `%` is not escaped,
 * so `a%23b` and `a#b` reach the server identically. Full `encodeURIComponent` is not the fix —
 * it would also escape `/` and break every path key. Resolving it needs the content server to
 * agree on one encoding for the whole key (super-repo #2725 follow-up).
 */
function encodeResourceKeyForUrl(resourceKey: string): string {
  return resourceKey.replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * Parse URN: urn:dig:{chain}:{storeId}:{roothash}/{resourceKey}[?salt=<hex>]
 *
 * Single shared parser for every consumer in the extension — the Node test server
 * (server.js, CommonJS require) and the module service worker (background.js, ESM
 * import). It accepts the union of inputs those callers pass: a `chia://` scheme
 * prefix, leading slashes, the `urn:dig:` prefix, and an optional `?salt=<hex>`
 * private-store query param. `salt` is always present in the result (null = public
 * store) so background.js's `parsed.salt ?? null` read is satisfied.
 *
 * parseURN returns `{ chain, storeId, roothash, resourceKey, salt }`. Capsule
 * semantics (canonical, see ../../SYSTEM.md): a capsule = one immutable store
 * generation = the pair `(storeId, rootHash)`, written `storeId:rootHash`; a
 * store is a sequence of capsules (one per commit). If `roothash` is present, the
 * URN identifies a SPECIFIC capsule (`storeId:roothash`). A rootless URN
 * (`roothash === null`) references the store's LATEST capsule.
 *
 * @param {string} urnString - URN string (with or without `chia://` / `urn:dig:` prefix)
 * @returns {Object|null} `{ chain, storeId, roothash, resourceKey, salt }` or null if invalid
 */
function parseURN(urnString: string): ParsedUrn | null {
  if (!urnString || typeof urnString !== 'string') {
    return null;
  }

  // Remove chia:// scheme prefix if present (callers may pass the raw chia:// URL)
  urnString = urnString.replace(/^chia:\/\//i, '');

  // Remove leading slash(es) if present (path-style callers)
  urnString = urnString.replace(/^\/+/, '');

  // Remove urn:dig: prefix if present
  urnString = urnString.replace(/^urn:dig:/i, '');

  // Split off an optional `?…salt=<hex>…` query before parsing the path. Conformance with the
  // sibling parsers is verified by running the shared table (`urn-conformance.test.ts`), never
  // asserted here.
  const split = splitQuery(urnString);
  const salt = split.salt;
  urnString = split.base;

  // Two forms share this string, and they are ambiguous unless the bare form is tried
  // FIRST (super-repo #741):
  //   1. bare (#686 canonical content link):  {storeId}[:{roothash}][/{resourceKey}]
  //   2. chain-prefixed:                       {chain}:{storeId}[:{roothash}][/{resourceKey}]
  // A storeId/roothash is always 64 hex; a chain label is a short alnum like `chia`, NEVER
  // 64 hex. So a LEADING 64-hex segment is unambiguously the storeId — matching the bare
  // form first prevents `chia://<storeId>:<root>` from being mis-read as chain=<storeId>.
  const bareMatch = urnString.match(/^([a-f0-9]{64})(?::([a-f0-9]{64}))?(?:\/(.+))?$/i);
  if (bareMatch) {
    return {
      chain: 'chia',
      storeId: bareMatch[1].toLowerCase(),
      roothash: bareMatch[2] ? bareMatch[2].toLowerCase() : null,
      resourceKey: bareMatch[3] || '',
      salt,
    };
  }

  // Chain-prefixed form — the leading segment is a chain label (never 64 hex, so it can
  // only reach here after the bare match above declined).
  const chainMatch = urnString.match(/^([^:]+):([a-f0-9]{64})(?::([a-f0-9]{64}))?(?:\/(.+))?$/i);
  if (chainMatch) {
    return {
      chain: chainMatch[1].toLowerCase(),
      storeId: chainMatch[2].toLowerCase(),
      roothash: chainMatch[3] ? chainMatch[3].toLowerCase() : null,
      resourceKey: chainMatch[4] || '',
      salt,
    };
  }

  return null;
}

/**
 * Resolve hostname to URN (supports dig.local, localhost, and 127.0.0.1)
 * @param {string} hostname - Hostname from request
 * @param {string} pathname - Path from request
 * @returns {string|null} URN string or null if invalid
 */
function resolveHostToURN(hostname: string, pathname: string): string | null {
  // Support both dig.local and localhost as base domains
  const baseDomains = ['dig.local', 'localhost', '127.0.0.1'];
  let baseDomain = null;
  let subdomainPart = null;
  
  // Check which base domain matches
  for (const domain of baseDomains) {
    if (hostname === domain) {
      baseDomain = domain;
      subdomainPart = '';
      break;
    } else if (hostname.endsWith('.' + domain)) {
      baseDomain = domain;
      subdomainPart = hostname.replace(new RegExp('\\.' + domain.replace(/\./g, '\\.') + '$'), '');
      break;
    }
  }
  
  if (!baseDomain) {
    return null;
  }
  
  // Handle direct base domain (no subdomain)
  if (hostname === baseDomain) {
    // Check if path is direct URN format
    if (pathname.startsWith('/urn:dig:')) {
      return pathname.substring(1); // Remove leading slash
    }
    // Check if path is path-based format (64-char hex store ID)
    const pathMatch = pathname.match(/^\/([a-f0-9]{64})(?:\/(.+))?$/i);
    if (pathMatch) {
      const storeId = pathMatch[1].toLowerCase();
      const resourceKey = pathMatch[2] || '';
      return `urn:dig:chia:${storeId}${resourceKey ? '/' + resourceKey : ''}`;
    }
    return null;
  }
  
  // Handle subdomain format
  if (subdomainPart == null) return null;
  const subdomains = subdomainPart.split('.');
  
  if (subdomains.length === 1) {
    // Latest version: {encodedStoreId}.{baseDomain}/{resourceKey}
    try {
      const encodedStoreId = subdomains[0];
      const storeId = decodeStoreId(encodedStoreId);
      const resourceKey = pathname === '/' ? '' : pathname.substring(1); // Remove leading slash
      return `urn:dig:chia:${storeId}${resourceKey ? '/' + resourceKey : ''}`;
    } catch (e) {
      console.error('Failed to decode store ID:', e);
      return null;
    }
  } else if (subdomains.length === 2) {
    // Specific version: {encodedStoreId}.{encodedRootHash}.{baseDomain}/{resourceKey}
    try {
      const encodedStoreId = subdomains[0];
      const encodedRootHash = subdomains[1];
      const storeId = decodeStoreId(encodedStoreId);
      const rootHash = decodeStoreId(encodedRootHash);
      const resourceKey = pathname === '/' ? '' : pathname.substring(1); // Remove leading slash
      return `urn:dig:chia:${storeId}:${rootHash}${resourceKey ? '/' + resourceKey : ''}`;
    } catch (e) {
      console.error('Failed to decode store ID or root hash:', e);
      return null;
    }
  }
  
  return null;
}

/**
 * Convert URN to content server URL
 * @param {string} urn - URN string
 * @param {Object} options - Options for URL generation
 * @param {string} options.host - Hostname (default: 'dig.local' or 'localhost' based on resolvability)
 * @param {number} options.port - Port number (default: 80)
 * @returns {string|null} Content server URL or null if invalid URN
 */
function urnToContentServerUrl(urn: string, options: { host?: string; port?: number } = {}): string | null {
  const parsed = parseURN(urn);
  if (!parsed) {
    return null;
  }
  
  const host = options.host || 'dig.local';
  const port = options.port !== undefined ? options.port : 80;
  
  // Encode store ID to base36 for subdomain
  const encodedStoreId = encodeStoreId(parsed.storeId);
  
  // Build URL based on whether roothash is present
  let url;
  if (parsed.roothash) {
    // Specific version: http://{encodedStoreId}.{encodedRootHash}.{host}:{port}/{resourceKey}
    const encodedRootHash = encodeStoreId(parsed.roothash);
    const resourceKey = encodeResourceKeyForUrl(parsed.resourceKey || '');
    url = `http://${encodedStoreId}.${encodedRootHash}.${host}${port !== 80 ? ':' + port : ''}/${resourceKey}`;
  } else {
    // Latest version: http://{encodedStoreId}.{host}:{port}/{resourceKey}
    const resourceKey = encodeResourceKeyForUrl(parsed.resourceKey || '');
    url = `http://${encodedStoreId}.${host}${port !== 80 ? ':' + port : ''}/${resourceKey}`;
  }
  
  return url;
}

// Single source of truth. This file is an ES module: the shipping module service
// worker (background.js, manifest `"type": "module"`) imports these named exports
// directly. Node-side dev consumers (server/server.js, tests/) load it via dynamic
// `import()` since they run as CommonJS. There is no longer a second inlined copy
// of parseURN / the base36 helpers anywhere in the extension.
export {
  parseURN,
  decodeUrnParam,
  resolveHostToURN,
  encodeStoreId,
  decodeStoreId,
  urnToContentServerUrl,
  hexToInt,
  intToBase36,
  base36ToInt,
  intToHex,
};

