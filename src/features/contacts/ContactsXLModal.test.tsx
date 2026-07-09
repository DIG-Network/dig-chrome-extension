import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { ContactsXLModal } from '@/features/contacts/ContactsXLModal';
import { CONTACTS_KEY, RECENTS_KEY } from '@/features/contacts/useContacts';
import { normalizeAddress, type Contact } from '@/features/contacts/contacts';

/** Fabricated (format-valid, not real-key-derived) `xch1…` addresses — `isChiaAddress` is a pure
 * bech32m-shape regex, so any distinct `xch1[0-9a-z]{6,}` string is a valid fixture address. */
const addr = (n: number) => `xch1${'q'.repeat(6)}${n.toString(36).padStart(4, '0')}${'z'.repeat(40)}`;

function seed(over: Partial<Contact> & { id: string; label: string; address: string }): Contact {
  return { note: '', createdAt: 1, updatedAt: 1, ...over };
}

const ALICE = seed({ id: 'c1', label: 'Alice', address: normalizeAddress(addr(1)) });
const BEN = seed({ id: 'c2', label: 'Ben', address: normalizeAddress(addr(2)) });
const BOB = seed({ id: 'c3', label: 'Bob', address: normalizeAddress(addr(3)) });
const NINETYNINE_POOL = seed({ id: 'c4', label: '99 Pool', address: normalizeAddress(addr(4)) });

beforeEach(async () => {
  await chrome.storage.local.remove(CONTACTS_KEY);
  await chrome.storage.local.remove(RECENTS_KEY);
  // jsdom has no real layout, so Element.scrollIntoView doesn't exist — stub it so the A–Z rail's
  // jump-to-letter handler can be exercised without throwing.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('ContactsXLModal (#207 — XL Android-style contacts modal)', () => {
  it('shows a loading state, then the empty state + "Add contact" CTA when the address book is empty', async () => {
    const onManage = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} onManage={onManage} />);
    expect(await screen.findByTestId('contacts-xl-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contacts-xl-add'));
    expect(onManage).toHaveBeenCalled();
  });

  it('groups saved contacts into sticky A–Z sections, each with its letter header', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE, BEN, BOB, NINETYNINE_POOL] });
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} />);

    await screen.findByTestId('contacts-xl-section-A');
    expect(screen.getByTestId('contacts-xl-section-B')).toBeInTheDocument();
    // The '#' (non-alphabetic) section sorts LAST.
    const sectionOrder = screen
      .getAllByText(/^[A-Z#]$/)
      .map((el) => el.textContent)
      .filter((t): t is string => t === 'A' || t === 'B' || t === '#');
    expect(sectionOrder.indexOf('#')).toBeGreaterThan(sectionOrder.indexOf('B'));

    // Within the "B" section, Ben sorts before Bob.
    const bSection = screen.getByTestId('contacts-xl-section-B');
    const names = Array.from(bSection.querySelectorAll('[data-testid^="pick-contact-"]')).map((el) => el.textContent);
    expect(names[0]).toContain('Ben');
    expect(names[1]).toContain('Bob');
  });

  it('selecting a contact calls onPick with its address and closes', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE] });
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={onPick} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('pick-contact-c1'));
    expect(onPick).toHaveBeenCalledWith(ALICE.address);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lists unsaved recent recipients above the saved-contact sections', async () => {
    const recentAddr = normalizeAddress(addr(9));
    await chrome.storage.local.set({ [RECENTS_KEY]: [{ address: recentAddr, lastUsedAt: 5 }] });
    const onPick = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={onPick} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId(`pick-recent-${recentAddr}`));
    expect(onPick).toHaveBeenCalledWith(recentAddr);
  });

  it('search narrows the list to matching contacts (by label or address) and hides the A–Z rail', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE, BEN, BOB] });
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} />);
    await screen.findByTestId('contacts-xl-section-A');
    expect(screen.getByTestId('contacts-xl-index')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('contacts-xl-search'), { target: { value: 'ali' } });
    expect(screen.getByTestId('pick-contact-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('pick-contact-c2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pick-contact-c3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contacts-xl-index')).not.toBeInTheDocument();
  });

  it('a search matching nothing shows a "no results" message, never the empty-address-book state', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE] });
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} />);
    await screen.findByTestId('contacts-xl-section-A');
    fireEvent.change(screen.getByTestId('contacts-xl-search'), { target: { value: 'zzz-no-match' } });
    expect(await screen.findByTestId('contacts-xl-no-results')).toBeInTheDocument();
    expect(screen.queryByTestId('contacts-xl-empty')).not.toBeInTheDocument();
  });

  it('the A–Z rail disables letters with no contacts and jumping to an available letter scrolls its section', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE, BOB] });
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} />);
    await screen.findByTestId('contacts-xl-section-A');

    expect(screen.getByTestId('contacts-xl-index-A')).toBeEnabled();
    expect(screen.getByTestId('contacts-xl-index-B')).toBeEnabled();
    expect(screen.getByTestId('contacts-xl-index-Z')).toBeDisabled();

    fireEvent.click(screen.getByTestId('contacts-xl-index-B'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('offers a Manage link when onManage is provided', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE] });
    const onManage = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} onManage={onManage} />);
    fireEvent.click(await screen.findByTestId('contact-picker-manage'));
    expect(onManage).toHaveBeenCalled();
  });

  it('Escape closes; the close button closes without picking', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE] });
    const onClose = vi.fn();
    const onPick = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={onPick} onClose={onClose} />);
    await screen.findByTestId('contacts-xl-section-A');

    fireEvent.click(screen.getByTestId('contacts-xl-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a backdrop click closes; a click on the dialog itself does not', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE] });
    const onClose = vi.fn();
    renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={onClose} />);
    await screen.findByTestId('contacts-xl-section-A');

    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('contacts-xl-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is a focus-trapped, labelled dialog with no WCAG violations', async () => {
    await chrome.storage.local.set({ [CONTACTS_KEY]: [ALICE, BEN] });
    const { container } = renderWithProviders(<ContactsXLModal onPick={() => {}} onClose={() => {}} />);
    await screen.findByTestId('contacts-xl-section-A');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
