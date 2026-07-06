import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ContactsManager } from '@/features/contacts/ContactsManager';
import { CONTACTS_KEY, RECENTS_KEY } from '@/features/contacts/useContacts';
import golden from '@/lib/keystore/derive.golden.json';

const ADDR_A = golden.unhardened[0].address;
const ADDR_B = golden.unhardened[1].address;

beforeEach(async () => {
  await chrome.storage.local.remove(CONTACTS_KEY);
  await chrome.storage.local.remove(RECENTS_KEY);
});

/** Fill + submit the top add-contact form. */
function addContact(label: string, address: string, note = '') {
  fireEvent.change(screen.getByTestId('contact-add-label'), { target: { value: label } });
  fireEvent.change(screen.getByTestId('contact-add-address'), { target: { value: address } });
  if (note) fireEvent.change(screen.getByTestId('contact-add-note'), { target: { value: note } });
  fireEvent.click(screen.getByTestId('contact-add-submit'));
}

describe('ContactsManager', () => {
  it('shows the empty state when there are no contacts', async () => {
    renderWithProviders(<ContactsManager />);
    expect(await screen.findByTestId('contacts-empty')).toBeInTheDocument();
  });

  it('adds a contact → it appears in the list and the form resets', async () => {
    renderWithProviders(<ContactsManager />);
    addContact('Alice', ADDR_A, 'friend');
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByTestId('contacts-list')).toBeInTheDocument();
    // Form reset after a successful add.
    expect((screen.getByTestId('contact-add-label') as HTMLInputElement).value).toBe('');
  });

  it('rejects an empty name with a localized error and no list entry', async () => {
    renderWithProviders(<ContactsManager />);
    fireEvent.change(screen.getByTestId('contact-add-address'), { target: { value: ADDR_A } });
    fireEvent.click(screen.getByTestId('contact-add-submit'));
    expect(await screen.findByTestId('contact-add-error-label')).toHaveTextContent('Enter a name');
    expect(screen.queryByTestId('contacts-list')).not.toBeInTheDocument();
  });

  it('rejects an invalid address', async () => {
    renderWithProviders(<ContactsManager />);
    addContact('Bad', 'not-an-address');
    expect(await screen.findByTestId('contact-add-error-address')).toHaveTextContent('valid xch1');
  });

  it('rejects a duplicate address', async () => {
    renderWithProviders(<ContactsManager />);
    addContact('Alice', ADDR_A);
    await screen.findByText('Alice');
    addContact('Alice again', ADDR_A);
    expect(await screen.findByTestId('contact-add-error-address')).toHaveTextContent('already have a contact');
  });

  it('edits a contact — the label updates in place', async () => {
    renderWithProviders(<ContactsManager />);
    addContact('Alice', ADDR_A);
    const row = await screen.findByText('Alice');
    const id = row.getAttribute('data-testid')!.replace('contact-label-', '');

    fireEvent.click(screen.getByTestId(`contact-edit-btn-${id}`));
    const labelInput = await screen.findByTestId(`contact-edit-${id}-label`);
    fireEvent.change(labelInput, { target: { value: 'Alice B' } });
    fireEvent.click(screen.getByTestId(`contact-edit-${id}-submit`));

    expect(await screen.findByText('Alice B')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('deletes a contact via the two-step confirm', async () => {
    renderWithProviders(<ContactsManager />);
    addContact('Alice', ADDR_A);
    addContact('Bob', ADDR_B);
    const row = await screen.findByText('Alice');
    const id = row.getAttribute('data-testid')!.replace('contact-label-', '');

    fireEvent.click(screen.getByTestId(`contact-delete-btn-${id}`));
    fireEvent.click(await screen.findByTestId(`contact-delete-confirm-${id}`));

    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });
});
