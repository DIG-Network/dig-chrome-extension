/**
 * Address book / contacts (#88) — the PURE data logic for the extension's saved recipients: types,
 * defensive parsing, validation, CRUD-on-array, recent-recipient tracking, and the
 * label-for-address lookup the Send flow uses to prefer a saved name over a raw `xch1…` string.
 *
 * No DOM / `chrome.*` here — the storage seam (`useContacts`) and the UI are thin glue over this
 * module, so every branch is unit-testable (mirrors the `wallet-assets.ts` watched-CAT idiom).
 * Validation returns message-id CODES (never English literals) so the UI localizes them via
 * react-intl. Address validity is the shared `isChiaAddress` gate, so the address book and the Send
 * form never disagree about which strings are valid recipients.
 *
 * Sibling #74 (address-poisoning defenses) builds its lookalike-warning on this same store; the
 * shape is kept additive so #74 can extend it without a migration.
 */

import { isChiaAddress } from '@/lib/wallet-view';

/**
 * A saved recipient. `id` is a stable local id; `address` is a normalized `xch1…` bech32m string.
 *
 * Forward-compat (#208 chat epic): this shape is additive-only, like every other durable local
 * record in the extension — a future chat feature can add optional fields (an avatar, a DID) onto
 * the SAME record without a migration, so one contact powers both send + chat. Nothing here is
 * removed/renamed/repurposed to make room; add, never break.
 */
export interface Contact {
  id: string;
  label: string;
  address: string;
  /** Optional free-text note (e.g. "exchange deposit"). */
  note?: string;
  /** Creation / last-edit timestamps (ms since epoch). */
  createdAt: number;
  updatedAt: number;
}

/** A recently-used recipient address (whether or not it is also saved as a {@link Contact}). */
export interface RecentRecipient {
  address: string;
  lastUsedAt: number;
}

/** The editable fields of a contact (what an add/edit form supplies). */
export interface ContactInput {
  label: string;
  address: string;
  note?: string;
}

/** Per-field validation errors, each a react-intl message id (absent field = valid). */
export interface ContactErrors {
  label?: string;
  address?: string;
  note?: string;
}

/** Newest-first recent recipients are capped to this many entries. */
export const MAX_RECENTS = 8;
/** Upper bounds so a pasted blob can't bloat storage / the UI. */
export const MAX_LABEL_LEN = 60;
export const MAX_NOTE_LEN = 200;

/** Normalize an address for storage + comparison: string-coerce, trim, lowercase (bech32m is lower). */
export function normalizeAddress(raw: unknown): string {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * Validate an add/edit form. Returns `{ ok, errors }` where each error is a message id: a label is
 * required and bounded; the address must be a valid `xch1…`; the note is optional but bounded.
 */
export function validateContactInput(input: ContactInput): { ok: boolean; errors: ContactErrors } {
  const errors: ContactErrors = {};
  const label = String(input.label ?? '').trim();
  const note = String(input.note ?? '');
  if (!label) errors.label = 'contacts.error.label';
  else if (label.length > MAX_LABEL_LEN) errors.label = 'contacts.error.labelLong';
  if (!isChiaAddress(input.address)) errors.address = 'contacts.error.address';
  if (note.length > MAX_NOTE_LEN) errors.note = 'contacts.error.noteLong';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Coerce one raw stored entry into a clean {@link Contact}, or `null` if it isn't a valid contact. */
function coerceContact(entry: unknown): Contact | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  const label = String(o.label ?? '').trim();
  const address = normalizeAddress(o.address);
  if (!label || label.length > MAX_LABEL_LEN || !isChiaAddress(address)) return null;
  const note = String(o.note ?? '').slice(0, MAX_NOTE_LEN);
  const id = o.id != null && String(o.id).length > 0 ? String(o.id) : `c_${address}`;
  const createdAt = Number.isFinite(Number(o.createdAt)) ? Number(o.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : createdAt;
  return { id, label, address, note, createdAt, updatedAt };
}

/** Parse the persisted contacts list, dropping any junk / malformed entries. */
export function parseContacts(stored: unknown): Contact[] {
  if (!Array.isArray(stored)) return [];
  const out: Contact[] = [];
  for (const entry of stored) {
    const c = coerceContact(entry);
    if (c) out.push(c);
  }
  return out;
}

/** Parse the persisted recent-recipients list, dropping junk and capping to {@link MAX_RECENTS}. */
export function parseRecents(stored: unknown): RecentRecipient[] {
  if (!Array.isArray(stored)) return [];
  const out: RecentRecipient[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const address = normalizeAddress(o.address);
    if (!isChiaAddress(address)) continue;
    const lastUsedAt = Number.isFinite(Number(o.lastUsedAt)) ? Number(o.lastUsedAt) : 0;
    out.push({ address, lastUsedAt });
  }
  return out.slice(0, MAX_RECENTS);
}

/**
 * Add a validated contact to `list`. Rejects invalid input and duplicate addresses (case/space
 * insensitive). Returns `{ ok, contacts, errors? }` — `contacts` is a NEW array on success, the
 * parsed original otherwise.
 */
export function addContact(
  list: unknown,
  input: ContactInput,
  opts: { now: number; id: string },
): { ok: boolean; contacts: Contact[]; errors?: ContactErrors } {
  const current = parseContacts(list);
  const check = validateContactInput(input);
  if (!check.ok) return { ok: false, contacts: current, errors: check.errors };
  const address = normalizeAddress(input.address);
  if (current.some((c) => c.address === address)) {
    return { ok: false, contacts: current, errors: { address: 'contacts.error.duplicate' } };
  }
  const contact: Contact = {
    id: opts.id,
    label: input.label.trim(),
    address,
    note: String(input.note ?? '').trim(),
    createdAt: opts.now,
    updatedAt: opts.now,
  };
  return { ok: true, contacts: [...current, contact] };
}

/**
 * Update an existing contact by id with a partial patch. Re-validates the merged fields and rejects
 * an address collision with ANOTHER contact. Returns a NEW array on success.
 */
export function updateContact(
  list: unknown,
  id: string,
  patch: Partial<ContactInput>,
  now: number,
): { ok: boolean; contacts: Contact[]; errors?: ContactErrors } {
  const current = parseContacts(list);
  const idx = current.findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, contacts: current };
  const merged: ContactInput = {
    label: patch.label ?? current[idx].label,
    address: patch.address ?? current[idx].address,
    note: patch.note ?? current[idx].note,
  };
  const check = validateContactInput(merged);
  if (!check.ok) return { ok: false, contacts: current, errors: check.errors };
  const address = normalizeAddress(merged.address);
  if (current.some((c, i) => i !== idx && c.address === address)) {
    return { ok: false, contacts: current, errors: { address: 'contacts.error.duplicate' } };
  }
  const next = current.slice();
  next[idx] = {
    ...current[idx],
    label: merged.label.trim(),
    address,
    note: String(merged.note ?? '').trim(),
    updatedAt: now,
  };
  return { ok: true, contacts: next };
}

/** Remove a contact by id; returns a NEW list (no-op if the id is absent). */
export function removeContact(list: unknown, id: string): Contact[] {
  return parseContacts(list).filter((c) => c.id !== id);
}

/** Find a saved contact by address (case/space insensitive), or `null`. */
export function findContactByAddress(list: Contact[], address: unknown): Contact | null {
  const norm = normalizeAddress(address);
  if (!norm) return null;
  return list.find((c) => c.address === norm) ?? null;
}

/** The saved label for an address, or `null` when it isn't a known contact. */
export function labelForAddress(list: Contact[], address: unknown): string | null {
  return findContactByAddress(list, address)?.label ?? null;
}

/** Sort contacts by label, case-insensitively (stable, locale-aware). */
export function sortContacts(list: Contact[]): Contact[] {
  return list.slice().sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * A–Z section grouping for the XL contacts modal (#207). The label's first alphabetic character,
 * uppercased; a leading digit/symbol (or an empty label) groups under `'#'`, mirroring the Android
 * Contacts convention of a trailing catch-all bucket for non-alphabetic entries.
 */
export function sectionLetter(label: string): string {
  const ch = label.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : '#';
}

/** One sticky letter section in the XL contacts modal: the header letter + its contacts, in order. */
export interface ContactSection {
  letter: string;
  contacts: Contact[];
}

/**
 * Group contacts into sticky A–Z sections for the XL contacts modal (#207). Assumes `contacts` is
 * ALREADY sorted by label (e.g. via {@link sortContacts}), so each section's contacts come out in
 * order; the `'#'` section (non-alphabetic labels) always sorts LAST, after every lettered section.
 */
export function groupContactsByLetter(contacts: Contact[]): ContactSection[] {
  const groups = new Map<string, Contact[]>();
  for (const c of contacts) {
    const letter = sectionLetter(c.label);
    const bucket = groups.get(letter);
    if (bucket) bucket.push(c);
    else groups.set(letter, [c]);
  }
  const letters = [...groups.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, contacts: groups.get(letter)! }));
}

/**
 * Record a use of `address`, moving it to the front of the recents (de-duplicated) and capping the
 * list. An invalid address is ignored (returns the parsed list unchanged).
 */
export function recordRecent(list: unknown, address: unknown, now: number, cap = MAX_RECENTS): RecentRecipient[] {
  const current = parseRecents(list);
  const norm = normalizeAddress(address);
  if (!isChiaAddress(norm)) return current;
  const without = current.filter((r) => r.address !== norm);
  return [{ address: norm, lastUsedAt: now }, ...without].slice(0, cap);
}

/** Annotate recents (already newest-first) with a saved label when the address is a known contact. */
export function recentEntries(
  recents: RecentRecipient[],
  contacts: Contact[],
): Array<{ address: string; label: string | null; lastUsedAt: number }> {
  return recents.map((r) => ({ address: r.address, label: labelForAddress(contacts, r.address), lastUsedAt: r.lastUsedAt }));
}
