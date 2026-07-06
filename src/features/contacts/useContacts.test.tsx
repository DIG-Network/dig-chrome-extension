import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useContacts, CONTACTS_KEY, RECENTS_KEY } from '@/features/contacts/useContacts';
import golden from '@/lib/keystore/derive.golden.json';

const ADDR_A = golden.unhardened[0].address;
const ADDR_B = golden.unhardened[1].address;

beforeEach(async () => {
  await chrome.storage.local.remove(CONTACTS_KEY);
  await chrome.storage.local.remove(RECENTS_KEY);
});

describe('useContacts', () => {
  it('adds, exposes sorted contacts, and looks up labels by address', async () => {
    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.add({ label: 'Charlie', address: ADDR_B });
    });
    act(() => {
      result.current.add({ label: 'alice', address: ADDR_A });
    });

    await waitFor(() => expect(result.current.contacts).toHaveLength(2));
    // Sorted case-insensitively by label.
    expect(result.current.contacts.map((c) => c.label)).toEqual(['alice', 'Charlie']);
    expect(result.current.labelForAddress(ADDR_A)).toBe('alice');
    expect(result.current.contactForAddress(ADDR_B)?.label).toBe('Charlie');
  });

  it('reports validation errors from a failed add', async () => {
    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.ready).toBe(true));
    let res: { ok: boolean } | undefined;
    act(() => {
      res = result.current.add({ label: '', address: ADDR_A });
    });
    expect(res?.ok).toBe(false);
    expect(result.current.contacts).toHaveLength(0);
  });

  it('updates and removes a contact', async () => {
    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.add({ label: 'Alice', address: ADDR_A });
    });
    await waitFor(() => expect(result.current.contacts).toHaveLength(1));
    const id = result.current.contacts[0].id;

    act(() => {
      result.current.update(id, { label: 'Alice B' });
    });
    await waitFor(() => expect(result.current.contacts[0].label).toBe('Alice B'));

    act(() => {
      result.current.remove(id);
    });
    await waitFor(() => expect(result.current.contacts).toHaveLength(0));
  });

  it('records recent recipients newest-first', async () => {
    const { result } = renderHook(() => useContacts());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.recordRecent(ADDR_A);
    });
    act(() => {
      result.current.recordRecent(ADDR_B);
    });
    await waitFor(() => expect(result.current.recents).toHaveLength(2));
    expect(result.current.recents[0].address).toBe(ADDR_B.toLowerCase());
  });
});
