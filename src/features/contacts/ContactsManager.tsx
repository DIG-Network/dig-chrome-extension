import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { shortenAddress } from '@/lib/wallet-view';
import { useContacts, type ContactOpResult } from '@/features/contacts/useContacts';
import type { Contact, ContactErrors, ContactInput } from '@/features/contacts/contacts';

/**
 * Address-book manager (#88) — the full CRUD screen: an add form at the top, then the saved
 * contacts (each editable inline / deletable with a two-step confirm). Reads + writes via
 * `useContacts` (durable `chrome.storage.local`, live across popup + `app.html`). All copy flows
 * through react-intl; validation errors are message ids resolved here. Empty state invites the
 * first contact.
 */
export function ContactsManager({ onClose }: { onClose?: () => void }) {
  const { contacts, add, update, remove } = useContacts();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <section className="dig-card" data-testid="contacts-manager" aria-labelledby="contacts-title">
      <h2 className="dig-heading" id="contacts-title">
        <FormattedMessage id="contacts.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="contacts.subtitle" />
      </p>

      {/* Add form (hidden while editing an existing contact to keep one active form). */}
      {editingId === null && (
        <ContactForm mode="add" onSubmit={(input) => add(input)} testid="contact-add" />
      )}

      <h3 className="dig-heading" style={{ fontSize: '0.95em', marginTop: 18 }}>
        <FormattedMessage id="contacts.list.title" />
      </h3>

      {contacts.length === 0 ? (
        <div className="dig-state" data-state="empty" data-testid="contacts-empty">
          <FormattedMessage id="contacts.empty" />
        </div>
      ) : (
        <ul className="dig-contact-list" data-testid="contacts-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {contacts.map((c) =>
            editingId === c.id ? (
              <li key={c.id}>
                <ContactForm
                  mode="edit"
                  initial={c}
                  testid={`contact-edit-${c.id}`}
                  onSubmit={(input) => update(c.id, input)}
                  onDone={() => setEditingId(null)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={c.id}>
                <ContactRow contact={c} onEdit={() => setEditingId(c.id)} onDelete={() => remove(c.id)} />
              </li>
            ),
          )}
        </ul>
      )}

      {onClose && (
        <button type="button" className="dig-link" data-testid="contacts-close" onClick={onClose} style={{ marginTop: 12 }}>
          <FormattedMessage id="send.back" />
        </button>
      )}
    </section>
  );
}

/** One saved contact: label + shortened address + optional note, with Edit / Delete (2-step). */
function ContactRow({ contact, onEdit, onDelete }: { contact: Contact; onEdit: () => void; onDelete: () => void }) {
  const intl = useIntl();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="dig-contact-row" data-testid={`contact-row-${contact.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--dig-border, rgba(255,255,255,0.08))' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="dig-contact-label" data-testid={`contact-label-${contact.id}`} style={{ fontWeight: 600 }}>{contact.label}</div>
        <div className="dig-mono dig-muted" style={{ fontSize: '0.8em' }}>{shortenAddress(contact.address)}</div>
        {contact.note && <div className="dig-muted" style={{ fontSize: '0.8em', marginTop: 2 }}>{contact.note}</div>}
      </div>
      {confirming ? (
        <>
          <button type="button" className="dig-btn dig-btn--danger" data-testid={`contact-delete-confirm-${contact.id}`} onClick={onDelete}>
            <FormattedMessage id="contacts.delete.yes" />
          </button>
          <button type="button" className="dig-link" data-testid={`contact-delete-cancel-${contact.id}`} onClick={() => setConfirming(false)}>
            <FormattedMessage id="contacts.action.cancel" />
          </button>
        </>
      ) : (
        <>
          <button type="button" className="dig-btn" data-testid={`contact-edit-btn-${contact.id}`} aria-label={intl.formatMessage({ id: 'contacts.edit.aria' }, { label: contact.label })} onClick={onEdit}>
            <FormattedMessage id="contacts.action.edit" />
          </button>
          <button type="button" className="dig-btn" data-testid={`contact-delete-btn-${contact.id}`} aria-label={intl.formatMessage({ id: 'contacts.delete.aria' }, { label: contact.label })} onClick={() => setConfirming(true)}>
            <FormattedMessage id="contacts.action.delete" />
          </button>
        </>
      )}
    </div>
  );
}

/** Shared add/edit form. `onSubmit` returns an op result; on success it resets (add) or calls `onDone` (edit). */
function ContactForm({
  mode,
  initial,
  testid,
  onSubmit,
  onDone,
  onCancel,
}: {
  mode: 'add' | 'edit';
  initial?: Contact;
  testid: string;
  onSubmit: (input: ContactInput) => ContactOpResult;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const intl = useIntl();
  const [label, setLabel] = useState(initial?.label ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [errors, setErrors] = useState<ContactErrors>({});

  function submit() {
    const res = onSubmit({ label, address, note });
    if (!res.ok) {
      setErrors(res.errors ?? {});
      return;
    }
    setErrors({});
    if (mode === 'add') {
      setLabel('');
      setAddress('');
      setNote('');
    }
    onDone?.();
  }

  return (
    <form
      className="dig-card"
      data-testid={testid}
      style={{ padding: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="dig-heading" style={{ fontSize: '0.9em', marginTop: 0 }}>
        <FormattedMessage id={mode === 'add' ? 'contacts.add.title' : 'contacts.edit.title'} />
      </p>
      <label className="dig-field">
        <span><FormattedMessage id="contacts.field.label" /></span>
        <input className="dig-input" data-testid={`${testid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" maxLength={80} />
      </label>
      {errors.label && <p className="dig-error-text" role="alert" data-testid={`${testid}-error-label`}><FormattedMessage id={errors.label} /></p>}
      <label className="dig-field">
        <span><FormattedMessage id="contacts.field.address" /></span>
        <input className="dig-input dig-mono" data-testid={`${testid}-address`} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" />
      </label>
      {errors.address && <p className="dig-error-text" role="alert" data-testid={`${testid}-error-address`}><FormattedMessage id={errors.address} /></p>}
      <label className="dig-field">
        <span><FormattedMessage id="contacts.field.note" /></span>
        <input className="dig-input" data-testid={`${testid}-note`} value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" maxLength={220} placeholder={intl.formatMessage({ id: 'contacts.field.note.placeholder' })} />
      </label>
      {errors.note && <p className="dig-error-text" role="alert" data-testid={`${testid}-error-note`}><FormattedMessage id={errors.note} /></p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="submit" className="dig-btn dig-btn--primary" data-testid={`${testid}-submit`}>
          <FormattedMessage id={mode === 'add' ? 'contacts.action.add' : 'contacts.action.save'} />
        </button>
        {mode === 'edit' && onCancel && (
          <button type="button" className="dig-link" data-testid={`${testid}-cancel`} onClick={onCancel}>
            <FormattedMessage id="contacts.action.cancel" />
          </button>
        )}
      </div>
    </form>
  );
}
