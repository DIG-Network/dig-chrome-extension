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
});

describe('ContactPicker', () => {
  it('renders nothing when there are no contacts and no recents', () => {
    const { container } = renderWithProviders(<ContactPicker onPick={() => {}} />);
    expect(container.querySelector('[data-testid="contact-picker"]')).toBeNull();
  });

  it('lists saved contacts and calls onPick with the address', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [seedContact()] });
    const onPick = vi.fn();
    renderWithProviders(<ContactPicker onPick={onPick} />);

    fireEvent.click(await screen.findByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('pick-contact-c1'));
    expect(onPick).toHaveBeenCalledWith(normalizeAddress(ADDR_A));
  });

  it('lists recent recipients that are not already saved contacts', async () => {
    await chrome.storage.local.set({ [RECENTS_KEY]: [{ address: normalizeAddress(ADDR_B), lastUsedAt: 5 }] });
    const onPick = vi.fn();
    renderWithProviders(<ContactPicker onPick={onPick} />);

    fireEvent.click(await screen.findByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId(`pick-recent-${normalizeAddress(ADDR_B)}`));
    expect(onPick).toHaveBeenCalledWith(normalizeAddress(ADDR_B));
  });

  it('offers a Manage link when onManage is provided', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [seedContact()] });
    const onManage = vi.fn();
    renderWithProviders(<ContactPicker onPick={() => {}} onManage={onManage} />);
    fireEvent.click(await screen.findByTestId('contact-picker-toggle'));
    fireEvent.click(await screen.findByTestId('contact-picker-manage'));
    expect(onManage).toHaveBeenCalled();
  });
});
