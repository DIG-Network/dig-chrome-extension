/**
 * Tests for the address-poisoning / confusable-recipient assessment (#74).
 *
 * Address poisoning: an attacker generates a vanity address that shares the SAME START AND END as
 * an address the victim knows (a saved contact or recent recipient) but differs in the middle, so
 * it looks identical in a truncated `xch1abcd…wxyz` display. The victim copies the poisoned address
 * from history and sends to the attacker. `assessRecipient` classifies a candidate against the
 * user's known-good set and flags a confusable lookalike BEFORE the send.
 */
import { describe, it, expect } from 'vitest';
import type { Contact } from './contacts';
import {
  CONFUSABLE_PREFIX,
  CONFUSABLE_SUFFIX,
  sharedAffixes,
  isConfusable,
  assessRecipient,
} from './address-poisoning';

/** Build a valid xch1 address from an explicit head (after `xch1`), middle, and tail. */
function mk(head: string, middle: string, tail: string): string {
  return `xch1${head}${middle}${tail}`.toLowerCase();
}

const contact = (address: string, label: string): Contact => ({
  id: `c_${label}`,
  label,
  address: address.toLowerCase(),
  note: '',
  createdAt: 1,
  updatedAt: 1,
});

const HEAD = 'qqqqhead'; // with `xch1` → a 12-char shared prefix region
const TAIL = 'wxyztail99'; // a 10-char shared tail region
const MID = (c: string) => c.repeat(34);

// A known contact address.
const ALICE = mk(HEAD, MID('0'), TAIL);
// A poison of ALICE: same head + tail, different middle (looks identical when truncated).
const ALICE_POISON = mk(HEAD, MID('1'), TAIL);
// An unrelated known recent recipient.
const BOB = mk('zzzzbody', MID('7'), 'mnopqr11');
// A poison of BOB.
const BOB_POISON = mk('zzzzbody', MID('9'), 'mnopqr11');

describe('affix helpers', () => {
  it('sharedAffixes counts equal leading and trailing characters', () => {
    const s = sharedAffixes(ALICE, ALICE_POISON);
    expect(s.prefix).toBeGreaterThanOrEqual(CONFUSABLE_PREFIX);
    expect(s.suffix).toBeGreaterThanOrEqual(CONFUSABLE_SUFFIX);
  });

  it('sharedAffixes of an address with itself is its full length both ways', () => {
    const s = sharedAffixes(ALICE, ALICE);
    expect(s.prefix).toBe(ALICE.length);
    expect(s.suffix).toBe(ALICE.length);
  });

  it('isConfusable flags a same-start-and-end, different-middle pair', () => {
    expect(isConfusable(ALICE, ALICE_POISON)).toBe(true);
  });

  it('isConfusable is false for identical addresses (it IS the address, not a lookalike)', () => {
    expect(isConfusable(ALICE, ALICE)).toBe(false);
  });

  it('isConfusable is false for unrelated addresses', () => {
    expect(isConfusable(ALICE, BOB)).toBe(false);
  });

  it('isConfusable is false when only the prefix matches (shared head, different tail)', () => {
    const samePrefixOnly = mk(HEAD, MID('0'), 'difftail9');
    expect(isConfusable(ALICE, samePrefixOnly)).toBe(false);
  });
});

describe('assessRecipient', () => {
  const contacts: Contact[] = [contact(ALICE, 'Alice')];
  const recents = [{ address: BOB, label: null }];

  it('classifies an empty / whitespace recipient as empty', () => {
    expect(assessRecipient('', contacts, recents).kind).toBe('empty');
    expect(assessRecipient('   ', contacts, recents).kind).toBe('empty');
  });

  it('classifies a malformed recipient as invalid', () => {
    expect(assessRecipient('not-an-address', contacts, recents).kind).toBe('invalid');
  });

  it('classifies an exact saved contact as known, carrying its label', () => {
    const a = assessRecipient(ALICE, contacts, recents);
    expect(a.kind).toBe('known');
    expect(a.matchedLabel).toBe('Alice');
  });

  it('is case- and whitespace-insensitive for the exact match', () => {
    expect(assessRecipient(`  ${ALICE.toUpperCase()}  `, contacts, recents).kind).toBe('known');
  });

  it('classifies an exact prior recipient (not a saved contact) as seen', () => {
    expect(assessRecipient(BOB, contacts, recents).kind).toBe('seen');
  });

  it('flags a lookalike of a saved contact and names the resembled entry', () => {
    const a = assessRecipient(ALICE_POISON, contacts, recents);
    expect(a.kind).toBe('lookalike');
    expect(a.lookalikes).toHaveLength(1);
    expect(a.lookalikes[0].address).toBe(ALICE);
    expect(a.lookalikes[0].label).toBe('Alice');
    expect(a.lookalikes[0].source).toBe('contact');
  });

  it('flags a lookalike of a recent recipient too (source: recent)', () => {
    const a = assessRecipient(BOB_POISON, contacts, recents);
    expect(a.kind).toBe('lookalike');
    expect(a.lookalikes[0].source).toBe('recent');
  });

  it('classifies an unrelated valid address never seen before as firstTime', () => {
    const stranger = mk('llllnope', MID('2'), 'qrstuv55');
    expect(assessRecipient(stranger, contacts, recents).kind).toBe('firstTime');
  });

  it('prefers an exact match over a lookalike (an exact contact is known)', () => {
    expect(assessRecipient(ALICE, contacts, recents).kind).toBe('known');
  });

  it('sorts multiple lookalikes by descending similarity, strongest first', () => {
    // CAROL is a weaker lookalike of ALICE_POISON: shares only the 10-char prefix + 8-char suffix
    // thresholds, vs ALICE's 12 + 10 — so ALICE must sort first.
    const carol = contact(mk('qqqqhezz', MID('5'), 'zyztail99'), 'Carol');
    const a = assessRecipient(ALICE_POISON, [contact(ALICE, 'Alice'), carol], []);
    expect(a.kind).toBe('lookalike');
    expect(a.lookalikes.length).toBeGreaterThanOrEqual(2);
    expect(a.lookalikes[0].label).toBe('Alice');
    for (let i = 1; i < a.lookalikes.length; i++) {
      const prev = a.lookalikes[i - 1].sharedPrefix + a.lookalikes[i - 1].sharedSuffix;
      const cur = a.lookalikes[i].sharedPrefix + a.lookalikes[i].sharedSuffix;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it('does not flag an address that merely shares the universal xch1 prefix', () => {
    const random = mk('9x8y7whv', MID('3'), 'zzzz0011');
    expect(assessRecipient(random, [contact(ALICE, 'Alice')], []).kind).toBe('firstTime');
  });

  it('deduplicates a contact that is also a recent — one lookalike entry, contact source wins', () => {
    const a = assessRecipient(ALICE_POISON, [contact(ALICE, 'Alice')], [{ address: ALICE, label: 'Alice' }]);
    expect(a.lookalikes).toHaveLength(1);
    expect(a.lookalikes[0].source).toBe('contact');
  });
});
