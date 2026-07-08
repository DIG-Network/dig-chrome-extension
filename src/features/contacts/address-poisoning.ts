/**
 * Address-poisoning / confusable-recipient assessment (#74) — the PURE logic behind the Send flow's
 * "this looks like a saved contact" warning.
 *
 * The attack: a recipient generates a vanity address whose START and END match an address the victim
 * already knows (a saved contact or a recent recipient) while the MIDDLE differs. Because every
 * wallet UI truncates an address to `xch1abcd…wxyz`, the poisoned address is visually
 * INDISTINGUISHABLE from the real one; the victim later copies the attacker's address out of their
 * history and sends to it. `assessRecipient` classifies a candidate against the user's known-good set
 * and flags a confusable lookalike BEFORE the spend is built.
 *
 * Pure (no DOM / chrome.*): the confusable heuristic is defined against the SAME truncation the UI
 * shows (`shortenAddress` head=10 / tail=8), so "flagged" means "renders identically in the wallet".
 * Builds on the existing address book (`contacts.ts`) — additive, no storage migration.
 */
import { normalizeAddress, type Contact } from './contacts';
import { isChiaAddress } from '@/lib/wallet-view';

/**
 * How many leading / trailing characters two addresses must share (while differing overall) to be
 * "confusable". These mirror `shortenAddress`'s default head (10) / tail (8): a candidate that
 * matches a known address on both is byte-identical in the truncated display a human reads. The
 * universal `xch1` prefix (4 chars) is well inside the 10-char prefix window, so a match implies a
 * DELIBERATE start-and-end collision — random addresses do not collide on 10 + 8 characters.
 */
export const CONFUSABLE_PREFIX = 10;
export const CONFUSABLE_SUFFIX = 8;

/** The classification of a candidate recipient against the user's known addresses. */
export type RecipientRiskKind =
  | 'empty' // nothing entered yet
  | 'invalid' // not a well-formed xch1 address
  | 'known' // exactly a saved contact — safe
  | 'seen' // exactly a prior recipient (not a saved contact) — familiar
  | 'firstTime' // a valid, never-seen, non-confusable address
  | 'lookalike'; // resembles (but is not) a known address — the poisoning risk

/** A known-good address the candidate is compared against. */
export interface KnownAddress {
  address: string;
  label: string | null;
  source: 'contact' | 'recent';
}

/** A known address the candidate is confusable with, plus the shared-affix lengths driving it. */
export interface LookalikeMatch extends KnownAddress {
  sharedPrefix: number;
  sharedSuffix: number;
}

/** The full assessment returned to the Send UI. */
export interface RecipientAssessment {
  kind: RecipientRiskKind;
  /** The matched contact label for `known` (its label) / `seen` (null); else null. */
  matchedLabel: string | null;
  /** For `lookalike`: the confusable known addresses, most-similar first. Empty otherwise. */
  lookalikes: LookalikeMatch[];
}

/** A recent-recipient entry as the address book surfaces it (label present when it is also a contact). */
export interface RecentLike {
  address: string;
  label?: string | null;
}

/** Number of equal leading characters shared by `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Number of equal trailing characters shared by `a` and `b`. */
function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** The shared leading / trailing character counts between two addresses. */
export function sharedAffixes(a: string, b: string): { prefix: number; suffix: number } {
  return { prefix: commonPrefixLen(a, b), suffix: commonSuffixLen(a, b) };
}

/**
 * True when `a` and `b` are DIFFERENT addresses that nonetheless share at least `prefixLen` leading
 * and `suffixLen` trailing characters — i.e. they collide on exactly the parts a truncated display
 * shows, the signature of an address-poisoning lookalike.
 */
export function isConfusable(
  a: string,
  b: string,
  prefixLen: number = CONFUSABLE_PREFIX,
  suffixLen: number = CONFUSABLE_SUFFIX,
): boolean {
  if (a === b) return false;
  const { prefix, suffix } = sharedAffixes(a, b);
  return prefix >= prefixLen && suffix >= suffixLen;
}

/**
 * Merge contacts + recents into one known-good set, de-duplicated by address (a contact entry wins
 * over a bare recent for the same address, so the more-informative label/source is kept).
 */
export function buildKnownSet(contacts: readonly Contact[], recents: readonly RecentLike[]): KnownAddress[] {
  const byAddress = new Map<string, KnownAddress>();
  for (const c of contacts) {
    const address = normalizeAddress(c.address);
    if (!address) continue;
    byAddress.set(address, { address, label: c.label ?? null, source: 'contact' });
  }
  for (const r of recents) {
    const address = normalizeAddress(r.address);
    if (!address || byAddress.has(address)) continue; // contact entry already covers it
    byAddress.set(address, { address, label: r.label ?? null, source: 'recent' });
  }
  return [...byAddress.values()];
}

/**
 * Classify `rawAddress` against the user's saved contacts + recent recipients. An exact match is
 * `known`/`seen`; a valid address that collides on start+end with a known one (but is not it) is a
 * `lookalike`; an unrelated valid address is `firstTime`. Never throws.
 */
export function assessRecipient(
  rawAddress: unknown,
  contacts: readonly Contact[],
  recents: readonly RecentLike[],
): RecipientAssessment {
  const address = normalizeAddress(rawAddress);
  if (!address) return { kind: 'empty', matchedLabel: null, lookalikes: [] };
  if (!isChiaAddress(address)) return { kind: 'invalid', matchedLabel: null, lookalikes: [] };

  const exactContact = contacts.find((c) => normalizeAddress(c.address) === address);
  if (exactContact) return { kind: 'known', matchedLabel: exactContact.label ?? null, lookalikes: [] };

  const exactRecent = recents.find((r) => normalizeAddress(r.address) === address);
  if (exactRecent) return { kind: 'seen', matchedLabel: exactRecent.label ?? null, lookalikes: [] };

  const lookalikes: LookalikeMatch[] = [];
  for (const known of buildKnownSet(contacts, recents)) {
    if (!isConfusable(address, known.address)) continue;
    const { prefix, suffix } = sharedAffixes(address, known.address);
    lookalikes.push({ ...known, sharedPrefix: prefix, sharedSuffix: suffix });
  }
  lookalikes.sort((a, b) => b.sharedPrefix + b.sharedSuffix - (a.sharedPrefix + a.sharedSuffix));

  if (lookalikes.length > 0) return { kind: 'lookalike', matchedLabel: null, lookalikes };
  return { kind: 'firstTime', matchedLabel: null, lookalikes: [] };
}
