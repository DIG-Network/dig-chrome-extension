import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import '@/features/contacts/ContactsXLModal.css';
import { shortenAddress } from '@/lib/wallet-view';
import { useContacts } from '@/features/contacts/useContacts';
import { sectionLetter, groupContactsByLetter } from '@/features/contacts/contacts';

/** Every rail letter the Android-style A–Z fast-scroll index offers, in order. */
const ALPHABET = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

export interface ContactsXLModalProps {
  /** Called with the chosen (normalized) address; the modal closes itself right after. */
  onPick: (address: string) => void;
  onClose: () => void;
  /** Opens the full address-book manager (the header "Manage" link + the empty-state CTA). */
  onManage?: () => void;
}

/**
 * The XL Android-style contacts modal (#207) — the recipient-selection UI upgrade over the old
 * inline disclosure panel. Mimics the Android Contacts app: saved contacts are alphabetized into
 * sticky letter sections with a monogram avatar per row, a search box narrows the list live, and an
 * A–Z fast-scroll rail jumps straight to a letter's section. Unsaved recent recipients (#88) surface
 * in their own "Recent" group above the alphabetized sections. Builds on the pure address-book
 * store (`contacts.ts`) + the `useContacts` storage seam — this file owns only the selection UI.
 *
 * Reuses the exact XL-modal shell + focus-trap/portal mechanics `NftPickerModal` established for
 * #170 (`.dig-modal-xl*`, theme.css) — including the SAME `document.body` portal fix from #200 (a
 * modal rendered inside `.dig-screen` gets trapped below the compact layout's tab bar; portaling
 * clear of that ancestor chain sidesteps it entirely, for both stacking and positioning).
 *
 * All four async states (§6.4): loading while the durable contacts/recents read hydrates, a real
 * empty state (no contacts AND no recents) with an "Add contact" CTA, a distinct "no results" state
 * for a search that matches nothing (never the empty-address-book state), and the populated list.
 * There is no error branch — the pure parser (`parseContacts`/`parseRecents`) never throws; a
 * malformed stored entry is dropped, not surfaced as a failure.
 */
export function ContactsXLModal({ onPick, onClose, onManage }: ContactsXLModalProps) {
  const intl = useIntl();
  const { contacts, recents, ready } = useContacts();
  const [query, setQuery] = useState('');

  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Focus-trap + Escape + focus-restore — identical contract to NftPickerModal (#170).
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreTo.current?.focus?.();
    };
  }, [onClose]);

  // Recents that aren't already a saved contact (saved ones already appear under their letter).
  const unsavedRecents = useMemo(() => recents.filter((r) => !r.label), [recents]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const filteredContacts = useMemo(
    () => (searching ? contacts.filter((c) => c.label.toLowerCase().includes(q) || c.address.toLowerCase().includes(q)) : contacts),
    [contacts, q, searching],
  );
  const filteredRecents = useMemo(
    () => (searching ? unsavedRecents.filter((r) => r.address.toLowerCase().includes(q)) : unsavedRecents),
    [unsavedRecents, q, searching],
  );
  const sections = useMemo(() => groupContactsByLetter(filteredContacts), [filteredContacts]);
  const availableLetters = useMemo(() => new Set(sections.map((s) => s.letter)), [sections]);

  // The address book itself is empty (no contacts, no recents) — an actionable state regardless of
  // whatever (pointless) text is in the search box, mirroring Android's own "no contacts" screen.
  const addressBookEmpty = contacts.length === 0 && unsavedRecents.length === 0;
  const noMatches = !addressBookEmpty && filteredContacts.length === 0 && filteredRecents.length === 0;

  function choose(address: string) {
    onPick(address);
    onClose();
  }

  function jumpTo(letter: string) {
    const el = sectionRefs.current[letter];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
  }

  return createPortal(
    <div className="dig-modal-xl-backdrop" data-testid="contacts-xl-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dig-modal-xl"
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: 'contacts.picker.title' })}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dig-modal-xl-head">
          <h2 className="dig-heading" style={{ margin: 0 }}>
            <FormattedMessage id="contacts.picker.title" />
          </h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {onManage && (
              <button type="button" className="dig-link" data-testid="contact-picker-manage" onClick={onManage}>
                <FormattedMessage id="contacts.picker.manage" />
              </button>
            )}
            <button
              type="button"
              className="dig-iconbtn"
              data-testid="contacts-xl-close"
              aria-label={intl.formatMessage({ id: 'contacts.picker.close' })}
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="dig-modal-xl-toolbar">
          <input
            type="text"
            className="dig-input"
            data-testid="contacts-xl-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={intl.formatMessage({ id: 'contacts.picker.search.placeholder' })}
            aria-label={intl.formatMessage({ id: 'contacts.picker.search.label' })}
            autoComplete="off"
          />
        </div>

        <div className="dig-modal-xl-body">
          {!ready ? (
            <div className="dig-state" role="status" aria-live="polite" data-state="loading" data-testid="contacts-xl-loading">
              <FormattedMessage id="state.loading" />
            </div>
          ) : addressBookEmpty ? (
            <div className="dig-state" data-state="empty" data-testid="contacts-xl-empty">
              <p className="dig-heading" style={{ marginTop: 0 }}>
                <FormattedMessage id="contacts.picker.empty.title" />
              </p>
              <p className="dig-muted"><FormattedMessage id="contacts.picker.empty.body" /></p>
              {onManage && (
                <button type="button" className="dig-btn dig-btn--primary" data-testid="contacts-xl-add" onClick={onManage}>
                  <FormattedMessage id="contacts.picker.addContact" />
                </button>
              )}
            </div>
          ) : noMatches ? (
            <p className="dig-muted" data-testid="contacts-xl-no-results">
              <FormattedMessage id="contacts.picker.noResults" values={{ query }} />
            </p>
          ) : (
            <div className="dig-contacts-xl-columns">
              <div className="dig-contacts-xl-scroll">
                {filteredRecents.length > 0 && (
                  <section aria-labelledby="contacts-xl-recent-head">
                    <h3 id="contacts-xl-recent-head" className="dig-contacts-xl-section-head">
                      <FormattedMessage id="contacts.picker.recent" />
                    </h3>
                    <ul className="dig-contacts-xl-list" data-testid="contacts-xl-recent-list">
                      {filteredRecents.map((r) => (
                        <ContactRow
                          key={r.address}
                          initial="•"
                          label={shortenAddress(r.address)}
                          testid={`pick-recent-${r.address}`}
                          onSelect={() => choose(r.address)}
                        />
                      ))}
                    </ul>
                  </section>
                )}

                {sections.length > 0 && (
                  <section aria-label={intl.formatMessage({ id: 'contacts.picker.saved' })}>
                    {sections.map(({ letter, contacts: sectionContacts }) => (
                      <div
                        key={letter}
                        ref={(el) => {
                          sectionRefs.current[letter] = el;
                        }}
                        data-testid={`contacts-xl-section-${letter}`}
                      >
                        <h3 className="dig-contacts-xl-section-head">{letter}</h3>
                        <ul className="dig-contacts-xl-list">
                          {sectionContacts.map((c) => (
                            <ContactRow
                              key={c.id}
                              initial={sectionLetter(c.label)}
                              label={c.label}
                              secondary={shortenAddress(c.address)}
                              testid={`pick-contact-${c.id}`}
                              onSelect={() => choose(c.address)}
                            />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                )}
              </div>

              {!searching && sections.length > 0 && (
                <nav
                  className="dig-contacts-xl-index"
                  aria-label={intl.formatMessage({ id: 'contacts.picker.index.aria' })}
                  data-testid="contacts-xl-index"
                >
                  {ALPHABET.map((letter) => {
                    const enabled = availableLetters.has(letter);
                    return (
                      <button
                        key={letter}
                        type="button"
                        disabled={!enabled}
                        className="dig-contacts-xl-index-btn"
                        data-testid={`contacts-xl-index-${letter}`}
                        aria-label={intl.formatMessage({ id: 'contacts.picker.index.jumpTo' }, { letter })}
                        onClick={() => jumpTo(letter)}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </nav>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One selectable row: a monogram avatar + primary label + optional secondary line (the address). */
function ContactRow({ initial, label, secondary, testid, onSelect }: { initial: string; label: string; secondary?: string; testid: string; onSelect: () => void }) {
  return (
    <li>
      <button type="button" className="dig-contacts-xl-row" data-testid={testid} onClick={onSelect}>
        <span className="dig-contacts-xl-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="dig-contacts-xl-row-text">
          <span className={`dig-contacts-xl-row-label${secondary ? '' : ' dig-mono'}`}>{label}</span>
          {secondary && <span className="dig-mono dig-muted dig-contacts-xl-row-address">{secondary}</span>}
        </span>
      </button>
    </li>
  );
}
