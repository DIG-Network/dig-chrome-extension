import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { popOutToFullpage } from '@/lib/popout';
import type { WalletNft } from '@/offscreen/nfts';
import { useListCollectiblesQuery } from '@/features/collectibles/collectiblesApi';
import { NftDetail, NftMedia } from '@/features/collectibles/NftDetail';
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
 */
export function CollectiblesPanel({ full }: { full?: boolean } = {}) {
  const intl = useIntl();
  const isFull = full ?? isFullpageSurface();
  const list = useListCollectiblesQuery();
  const [selected, setSelected] = useState<WalletNft | null>(null);

  const nfts = list.data?.nfts ?? [];

  if (selected) {
    return <NftDetail nft={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div data-testid="collectibles-panel">
      <h2 className="dig-heading">
        <FormattedMessage id="collectibles.title" />
      </h2>
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
                <NftGrid nfts={group.nfts} onOpen={setSelected} />
              </section>
            ))}
          </div>
        ) : (
          <>
            <NftGrid nfts={nfts.slice(0, POPUP_LIMIT)} onOpen={setSelected} />
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

/** The responsive image grid of NFT tiles; each tile opens the detail view. */
function NftGrid({ nfts, onOpen }: { nfts: WalletNft[]; onOpen: (nft: WalletNft) => void }) {
  return (
    <ul
      className="dig-nft-grid"
      data-testid="nft-grid"
      style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 10 }}
    >
      {nfts.map((nft) => {
        const edition = editionLabel(nft);
        return (
          <li key={nft.launcherId}>
            <button
              type="button"
              className="dig-nft-tile"
              data-testid={`nft-tile-${nft.launcherId}`}
              onClick={() => onOpen(nft)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
            >
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
