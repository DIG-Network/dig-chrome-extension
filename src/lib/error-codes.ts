/**
 * Catalogued, machine-readable error codes for the chia:// content loader (resolver +
 * viewer). The whole point: every failure surfaced by the read path carries a STABLE
 * UPPER_SNAKE `code` an agent can branch on — distinct from the friendly human `message`
 * the UI shows. Today the wallet broker has clean codes (HTTP-like 200/202/4xx); this
 * module gives the OTHER paths (proxyRequest / convertDigUrl / getDataUrl / fetchContentViaRPC
 * / the viewer) the same determinism.
 *
 * ── Cross-surface contract ──────────────────────────────────────────────────────────────
 * The four `DIG_LOADER_CODES` below are the canonical ecosystem `dig-loader` surface,
 * owned by docs.dig.net's `static/error-codes.json` (and aligned with the native DIG
 * Browser's chia:// loader). They MUST stay byte-identical with that catalogue so an agent
 * sees the same code whether content fails to load in the extension or in the native
 * browser. See ../../SYSTEM.md → "Canonical terminology & branding" and AGENT_FRIENDLY.md.
 *
 * The extension additionally classifies two failure kinds that are specific to its
 * dual-transport model (a malformed chia:// address; a configured-but-unreachable LOCAL
 * dig-node). Those two (`DIG_ERR_INVALID_URN`, `DIG_ERR_DIGNODE_REQUIRED`) are NOT part of
 * the shared cross-surface subset — they live in `DIG_ERR` and are documented in
 * `ERROR_CATALOGUE` with `canonical:false`.
 *
 * Plain ES module (no chrome.* / DOM) so the module SW (background.js), the viewer, and
 * tests under `node --test` can all import it.
 */

/**
 * The stable error-code enum. Each key === its string value (so `DIG_ERR.DIG_ERR_NETWORK`
 * is the literal `"DIG_ERR_NETWORK"`), making the code usable as both an identifier and a
 * wire value. Frozen so a caller cannot mutate the contract at runtime.
 *
 */
export type DigErrorCode =
  | 'DIG_ERR_PROOF_MISMATCH'
  | 'DIG_ERR_DECRYPT_TAG'
  | 'DIG_ERR_NOT_FOUND'
  | 'DIG_ERR_NETWORK'
  | 'DIG_ERR_INVALID_URN'
  | 'DIG_ERR_DIGNODE_REQUIRED';

/** The canonical machine envelope a loader failure returns. */
export interface CodedError {
  success: false;
  code: DigErrorCode;
  message: string;
}

export const DIG_ERR = Object.freeze({
  // ── Canonical dig-loader surface (mirrors docs static/error-codes.json) ──
  /** Served ciphertext did not verify against the on-chain generation root (tamper / wrong root). */
  DIG_ERR_PROOF_MISMATCH: 'DIG_ERR_PROOF_MISMATCH',
  /** AES-256-GCM-SIV authentication tag failed — wrong key/salt or corrupted bytes (also a decoy). */
  DIG_ERR_DECRYPT_TAG: 'DIG_ERR_DECRYPT_TAG',
  /** A blind miss (decoy) — no resource at this retrieval key under this generation. */
  DIG_ERR_NOT_FOUND: 'DIG_ERR_NOT_FOUND',
  /** The node/CDN was unreachable or the transport failed. */
  DIG_ERR_NETWORK: 'DIG_ERR_NETWORK',
  // ── Extension-local codes (not part of the shared cross-surface subset) ──
  /** The chia:// address / URN was malformed and could not be parsed. */
  DIG_ERR_INVALID_URN: 'DIG_ERR_INVALID_URN',
  /** A LOCAL dig-node is configured/required but is not installed or reachable. */
  DIG_ERR_DIGNODE_REQUIRED: 'DIG_ERR_DIGNODE_REQUIRED',
});

/**
 * The canonical cross-surface `dig-loader` subset — exactly the four codes that
 * docs.dig.net publishes and the native DIG Browser shares. Drift here breaks the
 * cross-module error catalog, so it is asserted in tests against the docs JSON spelling.
 * @type {readonly DigErrorCode[]}
 */
export const DIG_LOADER_CODES = Object.freeze([
  DIG_ERR.DIG_ERR_PROOF_MISMATCH,
  DIG_ERR.DIG_ERR_DECRYPT_TAG,
  DIG_ERR.DIG_ERR_NOT_FOUND,
  DIG_ERR.DIG_ERR_NETWORK,
]);

/**
 * The full, self-describing catalogue: one entry per code with a stable human message and
 * a `canonical` flag (true = part of the shared dig-loader surface). This is the artifact
 * an agent reads to learn the failure taxonomy without scraping source.
 * @type {readonly {code: DigErrorCode, message: string, canonical: boolean}[]}
 */
export const ERROR_CATALOGUE = Object.freeze([
  { code: DIG_ERR.DIG_ERR_PROOF_MISMATCH, canonical: true, message: 'The served content did not verify against the on-chain root (tamper or wrong root).' },
  { code: DIG_ERR.DIG_ERR_DECRYPT_TAG, canonical: true, message: 'The content could not be decrypted (wrong key/salt, corrupted bytes, or a decoy).' },
  { code: DIG_ERR.DIG_ERR_NOT_FOUND, canonical: true, message: 'No content found at this address under this generation.' },
  { code: DIG_ERR.DIG_ERR_NETWORK, canonical: true, message: 'The DIG Network was unreachable or the request failed.' },
  { code: DIG_ERR.DIG_ERR_INVALID_URN, canonical: false, message: 'That chia:// address is not valid.' },
  { code: DIG_ERR.DIG_ERR_DIGNODE_REQUIRED, canonical: false, message: 'The local dig-node is not installed or running.' },
]);

// Ordered classifier rules. ORDER MATTERS: a dig-node-required socket failure (ECONNREFUSED
// on loopback) must win over the generic network match, and an invalid-URN message must not
// be swallowed by anything else. Each rule is [regexp, code]; the first match wins.
const CLASSIFY_RULES: Array<[RegExp, DigErrorCode]> = [
  // Malformed address / URN.
  [/invalid urn|invalid chia:\/\/|malformed (urn|url)|not a valid (urn|address)/i, DIG_ERR.DIG_ERR_INVALID_URN],
  // Local dig-node configured but unreachable (loopback refused / branded local host).
  [/dig-?node|local node|econnrefused|dig\.local|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?/i, DIG_ERR.DIG_ERR_DIGNODE_REQUIRED],
  // Decrypt / GCM-SIV tag failure (also covers the decoy-or-wrong-key path).
  [/decrypt|gcm|wrong key|decoy/i, DIG_ERR.DIG_ERR_DECRYPT_TAG],
  // Merkle / inclusion-proof / integrity verification failure.
  [/inclusion proof|merkle|verif|integrity|chunk lengths|ciphertext length/i, DIG_ERR.DIG_ERR_PROOF_MISMATCH],
  // Network / transport / HTTP failure.
  [/failed to fetch|networkerror|load failed|could not reach|http error|enotfound|timeout|timed out|offline|fetch failed|no data/i, DIG_ERR.DIG_ERR_NETWORK],
];

/**
 * Classify a raw failure into a stable {@link DigErrorCode}.
 *
 * Accepts a string OR an Error: if the Error already carries a `.code` that is a known
 * DIG_ERR value, that code is returned unchanged (so a coded error stays coded as it
 * bubbles up); otherwise the `.message` is matched against the classifier rules. An
 * unrecognised message falls back to `DIG_ERR_NETWORK` (fail-safe: treat the unknown as a
 * recoverable availability problem rather than inventing a discriminant).
 *
 * @param {string|Error|null|undefined} input
 * @returns {DigErrorCode}
 */
export function classifyError(
  input: string | Error | { code?: string; message?: string } | null | undefined,
): DigErrorCode {
  let m: string;
  if (input && typeof input === 'object') {
    const rec = input as { code?: string; message?: string };
    if (typeof rec.code === 'string' && rec.code in DIG_ERR) return rec.code as DigErrorCode;
    m = String(rec.message || '');
  } else {
    m = String(input || '');
  }
  for (const [re, code] of CLASSIFY_RULES) {
    if (re.test(m)) return code;
  }
  return DIG_ERR.DIG_ERR_NETWORK;
}

/**
 * Build the canonical machine envelope for a loader failure:
 * `{ success: false, code, message }`. The `message` is kept as the original human prose
 * (for the UI / error page) — the `code` is the machine discriminant. Pass `codeOverride`
 * when the call site already knows the exact code (e.g. a known not-found / decoy path).
 *
 * @param {string|Error|null|undefined} input  raw failure (message or Error)
 * @param {DigErrorCode} [codeOverride]         force a specific code instead of classifying
 * @returns {{success: false, code: DigErrorCode, message: string}}
 */
export function makeError(
  input: string | Error | { code?: string; message?: string } | null | undefined,
  codeOverride?: DigErrorCode,
): CodedError {
  const message =
    input && typeof input === 'object'
      ? String((input as { message?: string }).message || '')
      : String(input || '');
  const code = codeOverride && codeOverride in DIG_ERR ? codeOverride : classifyError(input);
  return { success: false, code, message };
}
