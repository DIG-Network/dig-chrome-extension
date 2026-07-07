import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { popOutToFullpage } from '@/lib/popout';
import type { WalletNft } from '@/offscreen/nfts';
import { useListCollectiblesQuery } from '@/features/collectibles/collectiblesApi';
import { NftDetail, NftMedia } from '@/features/collectibles/NftDetail';
import { MintNft } from '@/features/collectibles/MintNft';
import { BulkNftActions } from '@/features/collectibles/BulkNftActions';
import { isFullpageSurface } from '@/features/collectibles/surface';
import {
  nftDisplayName,
  editionLabel,
  nftImageSrc,
  groupByCollection,
  shortHex,
} from '@/features/collectibles/nftDisplay';

/** How many tiles the constrained (popup) surface shows before "See all ⤢". */
const POPUP_LIMIT = 6;

/**
 * The Collectibles surface (§18.11) — the wallet's NFTs as an image grid grouped by collection, each
 * tile opening a {@link NftDetail} (metadata + transfer). Four states drive the list. On the popup
 * surface the grid is capped to {@link POPUP_LIMIT} with a "See all ⤢" that pops out the full-page
 * grid; the full page shows every collection. `full` is auto-detected from the surface (overridable
 * in tests).
 *
 * Multi-select bulk transfer/burn (#171) is ADVANCED → fullscreen only, mirroring mint (#92): the
 * popup never enters selection mode, offering an "open full screen" link instead. In selection mode
 * each tile becomes a toggle (checkbox overlay); a selection bar shows the count + select-all/clear +
 * Transfer/Burn, which hand the selected {@link WalletNft}s to {@link BulkNftActions}. The exported
 * `NftGrid` (below) is the reused selection primitive — #170's `NftPickerModal` (an XL modal picker
 * used by the NFT trade flow) renders the SAME grid in `selecting` mode rather than re-implementing
 * NFT tiles/checkboxes; only the surrounding chrome (search, pagination, confirm footer) differs.
 */
export function CollectiblesPanel({ full }: { full?: boolean } = {}) {
  const intl = useIntl();
  const isFull = full ?? isFullpageSurface();
  const list = useListCollectiblesQuery();
  const [selected, setSelected] = useState<WalletNft | null>(null);
  const [minting, setMinting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<'transfer' | 'burn' | null>(null);

  const nfts = list.data?.nfts ?? [];
  const selectedNfts = nfts.filter((n) => selectedIds.has(n.launcherId));

  function toggleSelected(launcherId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(launcherId)) next.delete(launcherId);
      else next.add(launcherId);
      return next;
    });
  }

  function exitSelection(): void {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  // Minting is ADVANCED functionality → fullscreen only. The compact popup stays streamlined (view-only,
  // with an "open full screen to mint" affordance); the mint form never renders in the popup.
  if (minting && isFull) {
    return <MintNft onDone={() => setMinting(false)} />;
  }
  if (bulkMode) {
    return (
      <BulkNftActions
        nfts={selectedNfts}
        mode={bulkMode}
        onDone={() => {
          setBulkMode(null);
          exitSelection();
        }}
      />
    );
  }
  if (selected) {
    return <NftDetail nft={selected} isFull={isFull} onBack={() => setSelected(null)} />;
  }

  return (
    <div data-testid="collectibles-panel">
      <div className="dig-toggle-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <h2 className="dig-heading" style={{ margin: 0 }}>
          <FormattedMessage id="collectibles.title" />
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: 6 }}>
          {isFull ? (
            <>
              {!selecting && (
                <button type="button" className="dig-link" data-testid="collectibles-select-enter" onClick={() => setSelecting(true)}>
                  <FormattedMessage id="collectibles.select.enter" />
                </button>
              )}
              <button type="button" className="dig-btn dig-btn--primary" data-testid="collectibles-mint" onClick={() => setMinting(true)}>
                <FormattedMessage id="mint.button" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="dig-link"
                data-testid="collectibles-bulk-fullscreen"
                onClick={() => void popOutToFullpage('#wallet/collectibles', true)}
              >
                <FormattedMessage id="collectibles.bulk.openFullscreen" />
              </button>
              <button
                type="button"
                className="dig-link"
                data-testid="collectibles-mint-fullscreen"
                onClick={() => void popOutToFullpage('#wallet/collectibles', true)}
              >
                <FormattedMessage id="mint.openFullscreen" />
              </button>
            </>
          )}
        </div>
      </div>

      {isFull && selecting && (
        <div className="dig-toggle-row" data-testid="collectibles-selection-bar" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="dig-muted" data-testid="collectibles-selection-count">
            <FormattedMessage id="collectibles.select.count" values={{ count: selectedIds.size }} />
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="dig-link" data-testid="collectibles-select-all" onClick={() => setSelectedIds(new Set(nfts.map((n) => n.launcherId)))}>
              <FormattedMessage id="collectibles.select.all" />
            </button>
            <button type="button" className="dig-link" data-testid="collectibles-select-clear" onClick={() => setSelectedIds(new Set())}>
              <FormattedMessage id="collectibles.select.clear" />
            </button>
            {selectedIds.size > 0 && (
              <>
                <button type="button" className="dig-btn dig-btn--primary" data-testid="collectibles-selection-transfer" onClick={() => setBulkMode('transfer')}>
                  <FormattedMessage id="collectibles.select.transfer" />
                </button>
                <button type="button" className="dig-btn dig-btn--danger" data-testid="collectibles-selection-burn" onClick={() => setBulkMode('burn')}>
                  <FormattedMessage id="collectibles.select.burn" />
                </button>
              </>
            )}
            <button type="button" className="dig-link" data-testid="collectibles-select-cancel" onClick={exitSelection}>
              <FormattedMessage id="collectibles.select.cancel" />
            </button>
          </div>
        </div>
      )}

      <FourState
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={!list.isLoading && !list.isError && nfts.length === 0}
        onRetry={() => void list.refetch()}
        testid="collectibles"
        loadingId="collectibles.loading"
        errorId="collectibles.error"
        emptyId="collectibles.empty"
      >
        {isFull ? (
          <div data-testid="collectibles-grouped">
            {groupByCollection(nfts).map((group) => (
              <section key={group.collectionId ?? 'ungrouped'} style={{ marginBottom: 18 }}>
                <h3 className="dig-heading" style={{ fontSize: 14 }}>
                  {group.collectionId
                    ? intl.formatMessage({ id: 'collectibles.collection.label' }, { id: shortHex(group.collectionId, 8, 6) })
                    : intl.formatMessage({ id: 'collectibles.collection.ungrouped' })}
                </h3>
                <NftGrid nfts={group.nfts} onOpen={setSelected} selecting={selecting} selectedIds={selectedIds} onToggle={toggleSelected} />
              </section>
            ))}
          </div>
        ) : (
          <>
            <NftGrid nfts={nfts.slice(0, POPUP_LIMIT)} onOpen={setSelected} selecting={false} selectedIds={selectedIds} onToggle={toggleSelected} />
            {nfts.length > POPUP_LIMIT && (
              <button
                type="button"
                className="dig-link"
                data-testid="collectibles-see-all"
                onClick={() => void popOutToFullpage('#wallet/collectibles', true)}
                style={{ marginTop: 8 }}
              >
                <FormattedMessage id="collectibles.seeAll" values={{ count: nfts.length }} />
              </button>
            )}
          </>
        )}
      </FourState>
    </div>
  );
}

/** {@link NftGrid}'s props — exported so other selection surfaces (the #170 {@link NftPickerModal}) can
 * reuse the exact same tile/checkbox-overlay markup instead of re-implementing it. */
export interface NftGridProps {
  nfts: WalletNft[];
  onOpen: (nft: WalletNft) => void;
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onToggle: (launcherId: string) => void;
}

/**
 * The responsive image grid of NFT tiles. Normally each tile opens the detail view; in `selecting`
 * mode (#171 — fullscreen-only bulk transfer/burn; also #170's {@link NftPickerModal}) a tile instead
 * TOGGLES membership in `selectedIds`, rendering a decorative checkmark overlay while the accessible
 * state/name moves onto the tile button itself (`aria-pressed` + a "Select {name}" label) — a screen
 * reader announces the toggle correctly without relying on the (aria-hidden) visual glyph. Exported
 * (#170) so the NFT-trade picker modal reuses this exact grid rather than re-implementing NFT tiles.
 */
export function NftGrid({ nfts, onOpen, selecting, selectedIds, onToggle }: NftGridProps) {
  const intl = useIntl();
  return (
    <ul
      className="dig-nft-grid"
      data-testid="nft-grid"
      style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 10 }}
    >
      {nfts.map((nft) => {
        const edition = editionLabel(nft);
        const isSelected = selectedIds.has(nft.launcherId);
        return (
          <li key={nft.launcherId}>
            <button
              type="button"
              className="dig-nft-tile"
              data-testid={`nft-tile-${nft.launcherId}`}
              onClick={() => (selecting ? onToggle(nft.launcherId) : onOpen(nft))}
              aria-pressed={selecting ? isSelected : undefined}
              aria-label={selecting ? intl.formatMessage({ id: 'collectibles.select.itemLabel' }, { name: nftDisplayName(nft) }) : undefined}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', position: 'relative' }}
            >
              {selecting && (
                <span
                  aria-hidden="true"
                  data-testid={`nft-select-${nft.launcherId}`}
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    zIndex: 1,
                    width: 20,
                    height: 20,
                    borderRadius: 5,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#fff',
                    border: '2px solid #fff',
                    background: isSelected ? 'var(--dig-accent, #7a3dff)' : 'rgba(0, 0, 0, 0.35)',
                  }}
                >
                  {isSelected ? '✓' : ''}
                </span>
              )}
              <NftMedia nft={nft} imageSrc={nftImageSrc(nft)} />
              <span className="dig-mono" style={{ display: 'block', fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {nftDisplayName(nft)}
              </span>
              {edition && <span className="dig-muted" style={{ display: 'block', fontSize: 10 }}>{edition}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
