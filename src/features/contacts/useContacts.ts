import { useCallback, useMemo } from 'react';
import { useStorageValue } from '@/lib/useStorageValue';
import {
  parseContacts,
  parseRecents,
  sortContacts,
  recentEntries,
  addContact,
  updateContact,
  removeContact,
  recordRecent as recordRecentPure,
  labelForAddress as labelForAddressPure,
  findContactByAddress,
  type Contact,
  type ContactInput,
  type ContactErrors,
} from '@/features/contacts/contacts';

/** `chrome.storage.local` keys for the address book (§18.4). Non-secret client data. */
export const CONTACTS_KEY = 'wallet.contacts';
export const RECENTS_KEY = 'wallet.recentRecipients';

/** Generate a stable local id (crypto.randomUUID where available; else a timestamp+random fallback). */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The result of a mutating op — `ok` plus any per-field validation errors to surface. */
export interface ContactOpResult {
  ok: boolean;
  errors?: ContactErrors;
}

/**
 * The address-book state seam (#88). Reads the two durable `chrome.storage.local` keys live via
 * `useStorageValue` (so the popup + `app.html` converge on `storage.onChanged`, §3.4) and exposes
 * typed CRUD + recent-recipient tracking + the label lookup the Send flow uses. All logic delegates
 * to the pure `contacts` module; this hook only owns the storage read/write + id/clock injection.
 */
export function useContacts() {
  const [rawContacts, setRawContacts, contactsReady] = useStorageValue<unknown>(CONTACTS_KEY, []);
  const [rawRecents, setRawRecents, recentsReady] = useStorageValue<unknown>(RECENTS_KEY, []);

  const contacts = useMemo(() => sortContacts(parseContacts(rawContacts)), [rawContacts]);
  const recents = useMemo(() => recentEntries(parseRecents(rawRecents), contacts), [rawRecents, contacts]);

  const add = useCallback(
    (input: ContactInput): ContactOpResult => {
      const res = addContact(rawContacts, input, { now: Date.now(), id: newId() });
      if (res.ok) setRawContacts(res.contacts);
      return { ok: res.ok, errors: res.errors };
    },
    [rawContacts, setRawContacts],
  );

  const update = useCallback(
    (id: string, patch: Partial<ContactInput>): ContactOpResult => {
      const res = updateContact(rawContacts, id, patch, Date.now());
      if (res.ok) setRawContacts(res.contacts);
      return { ok: res.ok, errors: res.errors };
    },
    [rawContacts, setRawContacts],
  );

  const remove = useCallback(
    (id: string): void => {
      setRawContacts(removeContact(rawContacts, id));
    },
    [rawContacts, setRawContacts],
  );

  const recordRecent = useCallback(
    (address: string): void => {
      setRawRecents(recordRecentPure(rawRecents, address, Date.now()));
    },
    [rawRecents, setRawRecents],
  );

  const labelForAddress = useCallback((address: string): string | null => labelForAddressPure(contacts, address), [contacts]);
  const contactForAddress = useCallback((address: string): Contact | null => findContactByAddress(contacts, address), [contacts]);

  return {
    contacts,
    recents,
    ready: contactsReady && recentsReady,
    add,
    update,
    remove,
    recordRecent,
    labelForAddress,
    contactForAddress,
  };
}
