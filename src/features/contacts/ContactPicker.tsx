import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { shortenAddress } from '@/lib/wallet-view';
import { useContacts } from '@/features/contacts/useContacts';

/**
 * Recipient picker for the Send flow (#88). A compact disclosure that lists the user's saved
 * contacts + recent recipients; choosing one fills the recipient address (via `onPick`) so nobody
 * pastes a raw `xch1…` twice. Renders NOTHING when the address book is empty AND there are no
 * recents — a first-time user's Send form stays clean (they save via add-on-send instead). An
 * optional `onManage` link jumps to the full address-book manager.
 */
export function ContactPicker({ onPick, onManage }: { onPick: (address: string) => void; onManage?: () => void }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const { contacts, recents } = useContacts();

  // Recents that aren't already a saved contact (saved ones already appear under "Saved contacts").
  const unsavedRecents = recents.filter((r) => !r.label);
  if (contacts.length === 0 && unsavedRecents.length === 0) return null;

  function choose(address: string) {
    onPick(address);
    setOpen(false);
  }

  return (
    <div className="dig-contact-picker" data-testid="contact-picker">
      <button
        type="button"
        className="dig-link"
        data-testid="contact-picker-toggle"
        aria-expanded={open}
        aria-controls="contact-picker-list"
        onClick={() => setOpen((v) => !v)}
      >
        <FormattedMessage id="contacts.picker.open" />
      </button>

      {open && (
        <div
          id="contact-picker-list"
          className="dig-card"
          role="group"
          aria-label={intl.formatMessage({ id: 'contacts.picker.title' })}
          data-testid="contact-picker-panel"
          style={{ marginTop: 8, padding: 10 }}
        >
          {contacts.length > 0 && (
            <>
              <p className="dig-muted" style={{ margin: '0 0 6px' }}>
                <FormattedMessage id="contacts.picker.saved" />
              </p>
              <ul className="dig-picker-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {contacts.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="dig-picker-item"
                      data-testid={`pick-contact-${c.id}`}
                      onClick={() => choose(c.address)}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', textAlign: 'left', gap: 2, padding: '8px 6px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <span className="dig-picker-label">{c.label}</span>
                      <span className="dig-mono dig-muted" style={{ fontSize: '0.8em' }}>{shortenAddress(c.address)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {unsavedRecents.length > 0 && (
            <>
              <p className="dig-muted" style={{ margin: '8px 0 6px' }}>
                <FormattedMessage id="contacts.picker.recent" />
              </p>
              <ul className="dig-picker-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {unsavedRecents.map((r) => (
                  <li key={r.address}>
                    <button
                      type="button"
                      className="dig-picker-item dig-mono"
                      data-testid={`pick-recent-${r.address}`}
                      onClick={() => choose(r.address)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 6px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85em' }}
                    >
                      {shortenAddress(r.address)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {onManage && (
            <button type="button" className="dig-link" data-testid="contact-picker-manage" onClick={onManage} style={{ marginTop: 8 }}>
              <FormattedMessage id="contacts.picker.manage" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
