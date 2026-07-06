import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { FourState } from '@/components/FourState';
import { popOutToFullpage } from '@/lib/popout';
import { shortenAddress } from '@/lib/wallet-view';
import type { WalletDid } from '@/offscreen/dids';
import { useListDidsQuery } from '@/features/identity/identityApi';
import { CreateDid } from '@/features/identity/CreateDid';
import { DidDetail } from '@/features/identity/DidDetail';
import { isFullpageSurface } from '@/features/collectibles/surface';

/**
 * The Identity surface (§18.17, #93) — the wallet's DIDs as a list, each entry opening a
 * {@link DidDetail} (on-chain state + transfer). Four states drive the list. **Surface tiering
 * (#145): creating/transferring a DID is ADVANCED functionality → fullscreen (ExpandedLayout) ONLY.**
 * The list itself is view-only and renders on BOTH surfaces; the compact popup shows an "open full
 * screen" affordance instead of the create/transfer forms — mirrors `CollectiblesPanel`'s mint
 * tiering exactly. `full` is auto-detected from the surface (overridable in tests).
 */
export function DidPanel({ full }: { full?: boolean } = {}) {
  const isFull = full ?? isFullpageSurface();
  const list = useListDidsQuery();
  const [selected, setSelected] = useState<WalletDid | null>(null);
  const [creating, setCreating] = useState(false);

  const dids = list.data?.dids ?? [];

  // Creating a DID is ADVANCED functionality → fullscreen only. The compact popup stays streamlined
  // (view-only, with an "open full screen to create" affordance); the create form never renders in it.
  if (creating && isFull) {
    return <CreateDid onDone={() => setCreating(false)} />;
  }
  if (selected) {
    return <DidDetail did={selected} isFull={isFull} onBack={() => setSelected(null)} />;
  }

  return (
    <div data-testid="identity-panel">
      <div className="dig-toggle-row">
        <h2 className="dig-heading" style={{ margin: 0 }}>
          <FormattedMessage id="identity.title" />
        </h2>
        {isFull ? (
          <button type="button" className="dig-btn dig-btn--primary" data-testid="identity-create" onClick={() => setCreating(true)}>
            <FormattedMessage id="identity.create.button" />
          </button>
        ) : (
          <button
            type="button"
            className="dig-link"
            data-testid="identity-create-fullscreen"
            onClick={() => void popOutToFullpage('#wallet/did', true)}
          >
            <FormattedMessage id="identity.create.openFullscreen" />
          </button>
        )}
      </div>
      <FourState
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={!list.isLoading && !list.isError && dids.length === 0}
        onRetry={() => void list.refetch()}
        testid="identity"
        loadingId="identity.loading"
        errorId="identity.error"
        emptyId="identity.empty"
      >
        <ul
          className="dig-did-list"
          data-testid="did-list"
          style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
        >
          {dids.map((did) => (
            <li key={did.launcherId}>
              <button
                type="button"
                className="dig-btn"
                data-testid={`did-tile-${did.launcherId}`}
                onClick={() => setSelected(did)}
                style={{ display: 'block', width: '100%', textAlign: 'left' }}
              >
                <span className="dig-mono">{shortenAddress(did.launcherId, 10, 8)}</span>
              </button>
            </li>
          ))}
        </ul>
      </FourState>
    </div>
  );
}
