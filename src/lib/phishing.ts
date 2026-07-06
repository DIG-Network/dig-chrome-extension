/**
 * Chia/DIG-native phishing / malicious-origin protection (#67 P0-2).
 *
 * A strong vault does nothing against the dominant real-world attack: a lookalike site tricking the
 * user into connecting and signing. Before a webpage may connect to — or spend from — the wallet, the
 * SW checks its origin against a DIG-curated blocklist (refreshed on an interval into
 * `chrome.storage.local`) and against a set of deceptive-lookalike heuristics for the legitimate DIG
 * surfaces. A blocked origin is stopped pre-connect with a clear interstitial; a lookalike raises a
 * warn the user must acknowledge.
 *
 * ORIGINAL code — the concept was studied from wallet phishing controllers, but NOTHING is imported
 * from the Ethereum ecosystem (no `eth-phishing-detect`, no external list wired at build time). The
 * blocklist is a plain DIG-hosted JSON the extension refreshes at runtime; the seed below ships
 * empty (the source of truth is the live list) but the mechanism works day-1 offline.
 *
 * Pure: `assessOrigin` takes the dynamic blocklist (the SW loads it from storage) so this module is
 * fully unit-tested without chrome.* / network.
 */

/** `chrome.storage.local` key holding the refreshed blocklist ({ domains, fetchedAt }). */
export const PHISHING_BLOCKLIST_KEY = 'phishing.blocklist';
/** Default DIG-hosted blocklist URL (override via settings). Best-effort; failure keeps the last list. */
export const DEFAULT_BLOCKLIST_URL = 'https://rpc.dig.net/phishing-blocklist.json';
/** Refresh cadence (ms) — the SW alarm re-fetches the list this often. */
export const BLOCKLIST_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h

/** Bundled seed blocklist (ships empty; the live DIG list is the source of truth). */
export const SEED_BLOCKLIST: readonly string[] = Object.freeze([]);

/**
 * The legitimate DIG registrable surfaces. A host is trusted iff it equals one of these or is a
 * subdomain of one; a non-trusted host that *resembles* one of these is a lookalike.
 */
export const KNOWN_DIG_DOMAINS: readonly string[] = Object.freeze([
  'dig.net',
  'on.dig.net',
  'xchtip.app',
]);

/** Stable machine reasons for a non-ok verdict (drive the i18n message ids + agent consumers). */
export const PHISHING = Object.freeze({
  BLOCKLISTED: 'BLOCKLISTED',
  LOOKALIKE: 'LOOKALIKE',
} as const);

/** The verdict for one origin. */
export interface OriginRisk {
  verdict: 'ok' | 'warn' | 'block';
  reason: (typeof PHISHING)[keyof typeof PHISHING] | null;
}

const OK: OriginRisk = Object.freeze({ verdict: 'ok', reason: null });

/** Extract the lowercased hostname from an origin/URL, or null if it cannot be parsed. */
export function originHostname(origin: string | null | undefined): string | null {
  if (!origin || typeof origin !== 'string') return null;
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** True iff `host` equals `domain` or is a subdomain of it (label-boundary match, never substring). */
function isAtOrUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

/** True iff `host` is a legitimate DIG surface (a known DIG domain or a subdomain of one). */
export function isLegitDigOrigin(host: string): boolean {
  return KNOWN_DIG_DOMAINS.some((d) => isAtOrUnder(host, d));
}

/** True iff `host` (or a parent domain) is on the effective blocklist. */
function isBlocked(host: string, list: readonly string[]): boolean {
  return list.some((entry) => entry && isAtOrUnder(host, entry));
}

/**
 * Decode a single punycode label body (the part after `xn--`) to its Unicode string (RFC 3492).
 * Homoglyph domains are registered as IDNs, which `URL` re-encodes to `xn--…` ASCII — we must decode
 * back to Unicode before the confusable skeleton can see them. Returns null on malformed input.
 */
function decodePunycodeLabel(input: string): string | null {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;
  const decodeDigit = (cp: number): number =>
    cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : base;
  const adapt = (delta: number, numPoints: number, first: boolean): number => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  const output: number[] = [];
  const delim = input.lastIndexOf('-');
  for (let j = 0; j < (delim < 0 ? 0 : delim); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    output.push(c);
  }
  let i = 0, n = initialN, bias = initialBias;
  let idx = delim < 0 ? 0 : delim + 1;
  while (idx < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= input.length) return null;
      const digit = decodeDigit(input.charCodeAt(idx++));
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const outLen = output.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    i %= outLen;
    output.splice(i, 0, n);
    i++;
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

/** Decode any `xn--` (punycode/IDN) labels in a host back to Unicode; leaves other labels intact. */
function decodeIdnHost(host: string): string {
  return host
    .split('.')
    .map((label) => {
      if (!label.startsWith('xn--')) return label;
      const decoded = decodePunycodeLabel(label.slice(4));
      return decoded ?? label;
    })
    .join('.');
}

/**
 * Homoglyph skeleton: map the confusable characters seen in domain-spoofing to a canonical ASCII
 * form so `dıg.net` (dotless-i), `d1g.net`, `dllg.net` etc. collapse onto `dig.net`. Deliberately
 * small + conservative (only well-known confusables) to avoid false positives.
 */
function skeleton(host: string): string {
  const map: Record<string, string> = {
    'ı': 'i', 'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', '1': 'i', '|': 'i',
    '0': 'o', 'ο': 'o', 'о': 'o', 'ø': 'o',
    'ⅼ': 'l', 'ł': 'l',
    'а': 'a', 'ａ': 'a',
    'е': 'e', 'ё': 'e',
    'п': 'n', 'ｎ': 'n',
    'ѕ': 's',
    'т': 't',
    'г': 'r',
    'ԁ': 'd', 'ⅾ': 'd',
    'һ': 'h',
    'р': 'p',
    'ｇ': 'g',
  };
  return Array.from(host).map((ch) => map[ch] ?? ch).join('');
}

/**
 * True iff `host` is a deceptive lookalike of a DIG surface (and is NOT itself legitimate):
 *   - a homoglyph whose skeleton resolves to a legitimate DIG origin, or
 *   - a subdomain-spoof that places a real DIG domain in the LEFT of the hostname while the true
 *     registrable domain is the attacker's (e.g. `hub.dig.net.wallet-verify.com`).
 */
function isDigLookalike(host: string): boolean {
  // Homoglyph: decode any IDN labels, skeletonize; if that resolves to a legit DIG origin (and the
  // raw host does not), it is a confusable spoof (e.g. `dıg.net` → `dig.net`).
  const skel = skeleton(decodeIdnHost(host));
  if (skel !== host && isLegitDigOrigin(skel)) return true;
  // Subdomain-spoof: a known DIG domain appears followed by more labels (so it is not the suffix).
  return KNOWN_DIG_DOMAINS.some((d) => host.includes(d + '.') && !host.endsWith(d));
}

/**
 * Assess an origin before connect/sign. Precedence: a blocklist hit (block) beats a lookalike (warn).
 * `dynamicList` is the DIG-curated list the SW refreshed into storage; the bundled {@link SEED_BLOCKLIST}
 * is always unioned in so protection works before the first fetch.
 */
export function assessOrigin(origin: string | null | undefined, dynamicList: readonly string[] = []): OriginRisk {
  const host = originHostname(origin);
  if (!host) return OK;
  const list = SEED_BLOCKLIST.concat(dynamicList);
  if (isBlocked(host, list)) return { verdict: 'block', reason: PHISHING.BLOCKLISTED };
  if (!isLegitDigOrigin(host) && isDigLookalike(host)) return { verdict: 'warn', reason: PHISHING.LOOKALIKE };
  return OK;
}

/**
 * Parse a fetched blocklist payload into a normalized, deduped hostname array. Accepts either a bare
 * array of strings or `{ domains: string[] }`; drops non-strings / empties; lowercases + trims.
 */
export function parseBlocklistPayload(payload: unknown): string[] {
  const raw: unknown = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { domains?: unknown }).domains)
      ? (payload as { domains: unknown[] }).domains
      : null;
  if (!raw || !Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const h = e.trim().toLowerCase();
    if (h) out.add(h);
  }
  return [...out];
}
