import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';

/**
 * The XL "view larger" image lightbox for NFT art (#173) — opened by clicking the NFT detail hero
 * image (`NftMedia`'s `enableLightbox` branch, `NftDetail.tsx`). Renders the SAME already-resolved,
 * locally-cached (#159) image src the hero is already showing, fit-to-viewport with its aspect ratio
 * preserved, centered on a dimmed backdrop — never a re-fetch (the caller passes the resolved src it
 * already holds).
 *
 * Accessible like {@link Sheet} (`components/Sheet.tsx`, the Send/Receive modal): `role="dialog"` +
 * `aria-modal`, focus moves into the dialog on open + is restored to whatever had focus (the trigger)
 * on close, Tab is TRAPPED within the dialog, Escape closes, and a backdrop click closes (a click ON
 * the image itself does not, since it is not the backdrop). The focus-trap/Escape/backdrop mechanics
 * are intentionally duplicated rather than shared with `Sheet` — `Sheet` is a titled form sheet with a
 * scrollable body; this is a full-bleed image viewer with no header — each stays a small, self-
 * contained, single-purpose component.
 *
 * **Portaled to `document.body` (#200, the same fix as {@link NftPickerModal}, #170)** — see
 * `Sheet`'s doc comment / `DEVELOPMENT_LOG.md` for why an inline fixed overlay nested in a
 * `.dig-screen` can be silently confined/mis-stacked on a narrow fullscreen viewport.
 */
export function NftImageLightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Trap Tab within the dialog so keyboard focus can't reach the inert page behind it (WCAG 2.2).
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

  return createPortal(
    <div className="dig-lightbox-backdrop" data-testid="nft-lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dig-lightbox" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <button
          type="button"
          className="dig-iconbtn dig-lightbox-close"
          data-testid="nft-lightbox-close"
          aria-label={intl.formatMessage({ id: 'nft.lightbox.close' })}
          onClick={onClose}
        >
          ✕
        </button>
        <img src={src} alt="" className="dig-lightbox-img" data-testid="nft-lightbox-image" />
      </div>
    </div>,
    document.body,
  );
}
