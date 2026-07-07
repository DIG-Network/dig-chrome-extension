import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import type { WalletNft } from '@/offscreen/nfts';
import { useListCollectiblesQuery } from '@/features/collectibles/collectiblesApi';
import { NftGrid } from '@/features/collectibles/CollectiblesPanel';
import { nftDisplayName } from '@/features/collectibles/nftDisplay';

/** Tiles per page (#170) — the grid renders only this many at a time, with a "Load more" button
 * revealing the rest, so a large wallet never mounts hundreds of tiles at once (no scroll jank). */
const PAGE_SIZE = 24;

export interface NftPickerModalProps {
  /** Allow choosing more than one NFT (default true — the general case). Pass `false` for a
   * single-asset context (e.g. Trade's give side, §18.10 — the offer engine's v1 model supports at
   * most ONE offered NFT): selecting a new tile then REPLACES the prior pick instead of adding to
   * it, and the select-all/clear controls are hidden (they have no meaning for a single pick). */
  multiple?: boolean;
  /** Launcher ids already chosen when the modal opens (e.g. reopening to change an existing pick). */
  initialSelectedIds?: readonly string[];
  /** Message id for the dialog title (defaults to the generic "Select NFTs"). */
  titleId?: string;
  /** Called with the confirmed NFTs (in wallet order) when "Add N selected" is clicked. */
  onConfirm: (selected: WalletNft[]) => void;
  onClose: () => void;
}

/**
 * The XL modal NFT-selection picker (#170) — a scrollable, searchable, multi-select grid of the
 * wallet's NFTs used anywhere a flow needs the user to CHOOSE from their collectibles (currently the
 * NFT-trade give side, §18.10). Reuses {@link NftGrid} (the exact tile/checkbox markup #171's
 * Collectibles bulk-select already established) rather than re-implementing NFT tiles — only the
 * surrounding chrome (title, search, select-all/clear, pagination, the "Add N selected" confirm
 * footer) is new. Fetches its own data (`useListCollectiblesQuery`) so it is a drop-in, self-contained
 * picker for any caller.
 *
 * Accessible like {@link Sheet}/{@link NftImageLightbox}: `role="dialog"` + `aria-modal`, focus moves
 * into the dialog on open and is restored to the trigger on close, Tab is TRAPPED within the dialog,
 * Escape closes, and a backdrop click closes (a click on the dialog itself does not). The focus-trap
 * mechanics are intentionally duplicated rather than shared — each modal stays a small,
 * self-contained, single-purpose component (the same call made for `NftImageLightbox` vs `Sheet`).
 *
 * Sized "XL" (`.dig-modal-xl`, `theme.css`) — larger than the `Sheet` used for Send/Receive, since a
 * browsable NFT grid needs real estate; on narrow viewports it becomes a full-screen sheet (no page
 * horizontal scroll, #163). Search matches the displayed name, the full launcher id, or the
 * collection id (case-insensitive substring) — a search yielding zero results shows a distinct
 * "no results" message, never the empty-wallet state (`FourState`'s `isEmpty` reflects the WALLET
 * having zero NFTs, not the current filter).
 *
 * **Portaled to `document.body` (discovered while building #170 — a real, pre-existing layout trap).**
 * The mobile-OS screen wrapper (`.dig-screen`) plays a permanent (`animation-fill-mode: both`)
 * entrance animation whose resolved `transform` never reverts to the literal `none` keyword, which
 * establishes a CSS containing block for `position: fixed` descendants — and the compact layout's
 * `.dig-app[data-layout='compact'] > *` rule forces equal `z-index` onto the header/content/tab-bar
 * siblings, so the bottom tab bar (later in DOM order) paints ABOVE anything nested inside the
 * content area regardless of that content's own z-index. Together these silently confine an
 * ordinarily-rendered fixed modal to the current screen's scrolled box and stack it BELOW the tab
 * bar (intercepting its clicks) — reproducible today by rendering `Sheet`/`NftImageLightbox` deep in
 * a `.dig-screen` on a narrow fullscreen viewport. `createPortal(…, document.body)` sidesteps both
 * issues by detaching the modal from that ancestor chain entirely (for both positioning AND
 * stacking) without touching the shared layout CSS other modals still rely on.
 */
export function NftPickerModal({ multiple = true, initialSelectedIds = [], titleId = 'nftPicker.title', onConfirm, onClose }: NftPickerModalProps) {
  const intl = useIntl();
  const list = useListCollectiblesQuery();
  const nfts = useMemo(() => list.data?.nfts ?? [], [list.data?.nfts]);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set(initialSelectedIds));
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nfts;
    return nfts.filter(
      (n) => nftDisplayName(n).toLowerCase().includes(q) || n.launcherId.toLowerCase().includes(q) || (n.collectionId ?? '').toLowerCase().includes(q),
    );
  }, [nfts, query]);

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  function handleSearchChange(value: string): void {
    setQuery(value);
    setVisibleCount(PAGE_SIZE); // a new filter starts back at page one
  }

  function toggle(launcherId: string): void {
    setSelectedIds((prev) => {
      if (!multiple) return prev.has(launcherId) ? new Set() : new Set([launcherId]);
      const next = new Set(prev);
      if (next.has(launcherId)) next.delete(launcherId);
      else next.add(launcherId);
      return next;
    });
  }

  function confirm(): void {
    onConfirm(nfts.filter((n) => selectedIds.has(n.launcherId)));
  }

  return createPortal(
    <div className="dig-modal-xl-backdrop" data-testid="nft-picker-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dig-modal-xl" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: titleId })} tabIndex={-1} ref={ref}>
        <div className="dig-modal-xl-head">
          <h2 className="dig-heading" style={{ margin: 0 }}>
            <FormattedMessage id={titleId} />
          </h2>
          <button
            type="button"
            className="dig-iconbtn"
            data-testid="nft-picker-close"
            aria-label={intl.formatMessage({ id: 'nftPicker.close' })}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="dig-modal-xl-toolbar">
          <input
            type="text"
            className="dig-input"
            data-testid="nft-picker-search"
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={intl.formatMessage({ id: 'nftPicker.search.placeholder' })}
            aria-label={intl.formatMessage({ id: 'nftPicker.search.label' })}
          />
          {multiple && (
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button type="button" className="dig-link" data-testid="nft-picker-select-all" onClick={() => setSelectedIds(new Set(filtered.map((n) => n.launcherId)))}>
                <FormattedMessage id="nftPicker.selectAll" />
              </button>
              <button type="button" className="dig-link" data-testid="nft-picker-select-clear" onClick={() => setSelectedIds(new Set())}>
                <FormattedMessage id="nftPicker.clear" />
              </button>
            </div>
          )}
        </div>

        <div className="dig-modal-xl-body">
          <FourState
            isLoading={list.isLoading}
            isError={list.isError}
            isEmpty={!list.isLoading && !list.isError && nfts.length === 0}
            onRetry={() => void list.refetch()}
            testid="nft-picker"
            loadingId="nftPicker.loading"
            errorId="nftPicker.error"
            emptyId="nftPicker.empty"
          >
            {filtered.length === 0 ? (
              <p className="dig-muted" data-testid="nft-picker-no-results">
                <FormattedMessage id="nftPicker.noResults" />
              </p>
            ) : (
              <>
                <NftGrid nfts={visible} onOpen={() => {}} selecting selectedIds={selectedIds} onToggle={toggle} />
                {remaining > 0 && (
                  <button type="button" className="dig-link" data-testid="nft-picker-load-more" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)} style={{ marginTop: 10 }}>
                    <FormattedMessage id="nftPicker.loadMore" values={{ count: remaining }} />
                  </button>
                )}
              </>
            )}
          </FourState>
        </div>

        <div className="dig-modal-xl-footer">
          <span className="dig-muted" data-testid="nft-picker-count">
            <FormattedMessage id="nftPicker.count" values={{ count: selectedIds.size }} />
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dig-link" data-testid="nft-picker-cancel" onClick={onClose}>
              <FormattedMessage id="nftPicker.cancel" />
            </button>
            <button type="button" className="dig-btn dig-btn--primary" data-testid="nft-picker-confirm" disabled={selectedIds.size === 0} onClick={confirm}>
              <FormattedMessage id="nftPicker.confirm" values={{ count: selectedIds.size }} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
