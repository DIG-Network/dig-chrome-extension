import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ContactPicker } from '@/features/contacts/ContactPicker';
import { CONTACTS_KEY, RECENTS_KEY } from '@/features/contacts/useContacts';
import { normalizeAddress, type Contact } from '@/features/contacts/contacts';
import golden from '@/lib/keystore/derive.golden.json';

const ADDR_A = golden.unhardened[0].address;
const ADDR_B = golden.unhardened[1].address;

function seedContact(over: Partial<Contact> = {}): Contact {
  return { id: 'c1', label: 'Alice', address: normalizeAddress(ADDR_A), note: '', createdAt: 1, updatedAt: 1, ...over };
}

beforeEach(async () => {
  await chrome.storage.local.remove(CONTACTS_KEY);
  await chrome.storage.local.remove(RECENTS_KEY);
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ContactPicker (#88, upgraded to the #207 XL modal)', () => {
  it('always shows the trigger, even with an empty address book', () => {
    renderWithProviders(<ContactPicker onPick={() => {}} />);
    expect(screen.getByTestId('contact-picker-toggle')).toBeInTheDocument();
  });

  it('opens the XL contacts modal on click', async () => {
    renderWithProviders(<ContactPicker onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('contact-picker-toggle'));
    expect(await screen.findByTestId('contacts-xl-modal')).toBeInTheDocument();
  });

  it('lists saved contacts and calls onPick with the address, then closes the modal', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [seedContact()] });
    const onPick = vi.fn();
    renderWithProviders(<ContactPicker onPick={onPick} />);

    fireEvent.click(screen.getByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('pick-contact-c1'));
    expect(onPick).toHaveBeenCalledWith(normalizeAddress(ADDR_A));
    expect(screen.queryByTestId('contacts-xl-modal')).not.toBeInTheDocument();
  });

  it('lists recent recipients that are not already saved contacts', async () => {
    await chrome.storage.local.set({ [RECENTS_KEY]: [{ address: normalizeAddress(ADDR_B), lastUsedAt: 5 }] });
    const onPick = vi.fn();
    renderWithProviders(<ContactPicker onPick={onPick} />);

    fireEvent.click(screen.getByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId(`pick-recent-${normalizeAddress(ADDR_B)}`));
    expect(onPick).toHaveBeenCalledWith(normalizeAddress(ADDR_B));
  });

  it('offers a Manage link when onManage is provided', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [seedContact()] });
    const onManage = vi.fn();
    renderWithProviders(<ContactPicker onPick={() => {}} onManage={onManage} />);
    fireEvent.click(screen.getByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('contact-picker-manage'));
    expect(onManage).toHaveBeenCalled();
  });

  it('an empty address book shows the modal empty state with an "Add contact" CTA', async () => {
    const onManage = vi.fn();
    renderWithProviders(<ContactPicker onPick={() => {}} onManage={onManage} />);
    fireEvent.click(screen.getByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('contacts-xl-add'));
    expect(onManage).toHaveBeenCalled();
  });
});
