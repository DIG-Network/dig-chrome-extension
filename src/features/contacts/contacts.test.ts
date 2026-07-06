import { describe, it, expect } from 'vitest';
import golden from '@/lib/keystore/derive.golden.json';
import {
  parseContacts,
  parseRecents,
  validateContactInput,
  addContact,
  updateContact,
  removeContact,
  findContactByAddress,
  labelForAddress,
  sortContacts,
  recordRecent,
  recentEntries,
  normalizeAddress,
  MAX_RECENTS,
  MAX_LABEL_LEN,
  MAX_NOTE_LEN,
  type Contact,
} from '@/features/contacts/contacts';

const ADDR_A = golden.unhardened[0].address; // valid xch1 bech32m
const ADDR_B = golden.unhardened[1].address;

/** A stable-id, fixed-timestamp contact for list fixtures. */
function contact(over: Partial<Contact> = {}): Contact {
  return { id: 'c1', label: 'Alice', address: normalizeAddress(ADDR_A), note: '', createdAt: 100, updatedAt: 100, ...over };
}

describe('contacts — normalize + validate', () => {
  it('normalizes an address by trimming + lowercasing', () => {
    expect(normalizeAddress(`  ${ADDR_A.toUpperCase()} `)).toBe(ADDR_A.toLowerCase());
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress(123 as unknown)).toBe('123');
  });

  it('accepts a valid label + xch1 address, rejects bad input with per-field ids', () => {
    expect(validateContactInput({ label: 'Alice', address: ADDR_A }).ok).toBe(true);

    const noLabel = validateContactInput({ label: '   ', address: ADDR_A });
    expect(noLabel.ok).toBe(false);
    expect(noLabel.errors.label).toBe('contacts.error.label');

    const badAddr = validateContactInput({ label: 'Bob', address: 'not-an-address' });
    expect(badAddr.ok).toBe(false);
    expect(badAddr.errors.address).toBe('contacts.error.address');
  });

  it('rejects an over-long label or note', () => {
    expect(validateContactInput({ label: 'x'.repeat(MAX_LABEL_LEN + 1), address: ADDR_A }).errors.label).toBe('contacts.error.labelLong');
    expect(validateContactInput({ label: 'Ok', address: ADDR_A, note: 'y'.repeat(MAX_NOTE_LEN + 1) }).errors.note).toBe('contacts.error.noteLong');
  });
});

describe('contacts — defensive parsing', () => {
  it('parses only well-formed entries, dropping junk', () => {
    const raw = [
      { id: 'c1', label: 'Alice', address: ADDR_A, note: 'friend', createdAt: 1, updatedAt: 2 },
      { id: 'c2', label: '', address: ADDR_B }, // empty label → dropped
      { id: 'c3', label: 'Bad', address: 'nope' }, // invalid address → dropped
      'garbage',
      null,
      42,
    ];
    const out = parseContacts(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'c1', label: 'Alice', address: normalizeAddress(ADDR_A), note: 'friend' });
  });

  it('non-array storage → empty list', () => {
    expect(parseContacts(undefined)).toEqual([]);
    expect(parseContacts({})).toEqual([]);
    expect(parseContacts('x')).toEqual([]);
  });

  it('synthesizes a stable id + zero timestamps when missing', () => {
    const out = parseContacts([{ label: 'NoId', address: ADDR_A }]);
    expect(out[0].id).toBeTruthy();
    expect(out[0].createdAt).toBe(0);
  });
});

describe('contacts — CRUD', () => {
  it('adds a validated contact, generating id + timestamps', () => {
    const res = addContact([], { label: 'Alice', address: ADDR_A, note: 'friend' }, { now: 500, id: 'new-id' });
    expect(res.ok).toBe(true);
    expect(res.contacts).toHaveLength(1);
    expect(res.contacts[0]).toMatchObject({ id: 'new-id', label: 'Alice', address: normalizeAddress(ADDR_A), note: 'friend', createdAt: 500, updatedAt: 500 });
  });

  it('rejects an invalid add without mutating the list', () => {
    const start = [contact()];
    const res = addContact(start, { label: '', address: ADDR_B }, { now: 1, id: 'x' });
    expect(res.ok).toBe(false);
    expect(res.errors?.label).toBe('contacts.error.label');
    expect(res.contacts).toHaveLength(1);
  });

  it('rejects a duplicate address (case/space-insensitive)', () => {
    const res = addContact([contact()], { label: 'Alice2', address: `  ${ADDR_A.toUpperCase()} ` }, { now: 1, id: 'x' });
    expect(res.ok).toBe(false);
    expect(res.errors?.address).toBe('contacts.error.duplicate');
  });

  it('updates label/note and bumps updatedAt, keeping createdAt', () => {
    const res = updateContact([contact()], 'c1', { label: 'Alice B', note: 'bff' }, 900);
    expect(res.ok).toBe(true);
    expect(res.contacts[0]).toMatchObject({ label: 'Alice B', note: 'bff', createdAt: 100, updatedAt: 900 });
  });

  it('rejects updating to an address already held by another contact', () => {
    const list = [contact(), contact({ id: 'c2', label: 'Bob', address: normalizeAddress(ADDR_B) })];
    const res = updateContact(list, 'c2', { address: ADDR_A }, 900);
    expect(res.ok).toBe(false);
    expect(res.errors?.address).toBe('contacts.error.duplicate');
  });

  it('update on a missing id is a no-op failure', () => {
    const res = updateContact([contact()], 'zzz', { label: 'X' }, 1);
    expect(res.ok).toBe(false);
    expect(res.contacts).toHaveLength(1);
  });

  it('removes by id (no-op when absent)', () => {
    expect(removeContact([contact()], 'c1')).toHaveLength(0);
    expect(removeContact([contact()], 'nope')).toHaveLength(1);
  });
});

describe('contacts — lookup + sort', () => {
  const list = [
    contact({ id: 'c1', label: 'Charlie', address: normalizeAddress(ADDR_A) }),
    contact({ id: 'c2', label: 'alice', address: normalizeAddress(ADDR_B) }),
  ];

  it('finds a contact by address, ignoring case/whitespace', () => {
    expect(findContactByAddress(list, `  ${ADDR_A.toUpperCase()}`)?.id).toBe('c1');
    expect(findContactByAddress(list, 'missing')).toBeNull();
  });

  it('labelForAddress prefers the saved label, else null', () => {
    expect(labelForAddress(list, ADDR_B)).toBe('alice');
    expect(labelForAddress(list, 'xch1nobody')).toBeNull();
  });

  it('sorts by label case-insensitively', () => {
    expect(sortContacts(list).map((c) => c.label)).toEqual(['alice', 'Charlie']);
  });
});

describe('contacts — recent recipients', () => {
  it('parses well-formed recents and drops junk', () => {
    const out = parseRecents([{ address: ADDR_A, lastUsedAt: 5 }, { address: 'bad' }, 'x', null]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: normalizeAddress(ADDR_A), lastUsedAt: 5 });
  });

  it('records a recent to the front, de-duplicates, and caps the list', () => {
    let recents = recordRecent([], ADDR_A, 10);
    recents = recordRecent(recents, ADDR_B, 20);
    recents = recordRecent(recents, ADDR_A, 30); // re-use A → moves to front, no dupe
    expect(recents.map((r) => r.address)).toEqual([normalizeAddress(ADDR_A), normalizeAddress(ADDR_B)]);
    expect(recents[0].lastUsedAt).toBe(30);
  });

  it('ignores an invalid address', () => {
    expect(recordRecent([], 'not-valid', 1)).toEqual([]);
  });

  it('caps at MAX_RECENTS newest-first', () => {
    let recents: ReturnType<typeof recordRecent> = [];
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      // distinct valid-looking addresses
      recents = recordRecent(recents, `xch1${'a'.repeat(10)}${i}`, i);
    }
    expect(recents.length).toBe(MAX_RECENTS);
    expect(recents[0].lastUsedAt).toBe(MAX_RECENTS + 4); // newest first
  });

  it('recentEntries annotates each with a saved label when known, newest first', () => {
    const recents = [
      { address: normalizeAddress(ADDR_B), lastUsedAt: 20 },
      { address: normalizeAddress(ADDR_A), lastUsedAt: 10 },
    ];
    const contacts = [contact({ id: 'c1', label: 'Alice', address: normalizeAddress(ADDR_A) })];
    const entries = recentEntries(recents, contacts);
    expect(entries.map((e) => e.label)).toEqual([null, 'Alice']);
    expect(entries.map((e) => e.address)).toEqual([normalizeAddress(ADDR_B), normalizeAddress(ADDR_A)]);
  });
});
