import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { ContactsXLModal } from '@/features/contacts/ContactsXLModal';

/**
 * Recipient-picker TRIGGER for the Send flow (#88, upgraded by #207). A single "Choose from address
 * book" link that opens the {@link ContactsXLModal} — the XL Android-style contacts modal (sticky
 * A–Z sections, fast-scroll index, search, avatars). Choosing a contact/recent fills the recipient
 * address (via `onPick`) so nobody pastes a raw `xch1…` twice, then closes the modal. The trigger is
 * ALWAYS shown (never hidden for an empty address book) — the modal itself renders the empty state
 * + an "Add contact" CTA, so a first-time user still has a discoverable path in. An optional
 * `onManage` opens the full address-book manager (surfaced inside the modal).
 */
export function ContactPicker({ onPick, onManage }: { onPick: (address: string) => void; onManage?: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="dig-contact-picker" data-testid="contact-picker">
      <button type="button" className="dig-link" data-testid="contact-picker-toggle" onClick={() => setOpen(true)}>
        <FormattedMessage id="contacts.picker.open" />
      </button>

      {open && (
        <ContactsXLModal
          onPick={(address) => {
            onPick(address);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          onManage={onManage}
        />
      )}
    </div>
  );
}
