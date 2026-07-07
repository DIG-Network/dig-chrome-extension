import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useGetLockStateQuery, useSetActiveIndexMutation } from '@/features/wallet/custodyApi';

/**
 * The single active-derivation-index navigator (#165) — the wallet operates on ONE HD derivation
 * index at a time; prev/next (+ click-to-jump) switches it. Every wallet view (balance, assets,
 * NFTs, DIDs, activity, receive address) reflects ONLY the active index — changing it here
 * invalidates them all via the RTK Query tag cache (`setActiveIndex`'s `invalidatesTags`), exactly
 * like the wallet switcher invalidates on a wallet change. A light SW registry op (no vault
 * round-trip, no key involved) — persisted per wallet (#90) so each wallet keeps its own place.
 *
 * Placed in the wallet shell beside `WalletSwitcher` — both are "which identity am I viewing"
 * controls (wallet identity vs. derivation index within it).
 */
export function IndexNavigator() {
  const intl = useIntl();
  const { data, isLoading } = useGetLockStateQuery();
  const [setActiveIndex, { isLoading: isSaving }] = useSetActiveIndexMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const activeIndex = data?.activeIndex ?? 0;
  const busy = isSaving;

  async function go(target: number): Promise<void> {
    setError(null);
    const clamped = Math.max(0, Math.floor(target));
    if (clamped === activeIndex) return;
    const res = await setActiveIndex({ index: clamped });
    if (!('data' in res)) {
      setError(intl.formatMessage({ id: 'wallet.index.error' }));
    }
  }

  function openJump(): void {
    setDraft(String(activeIndex));
    setEditing(true);
  }

  function submitJump(e: FormEvent): void {
    e.preventDefault();
    setEditing(false);
    const n = Number(draft);
    if (Number.isFinite(n)) void go(n);
  }

  // Loading (no cached lock-state yet) shows a neutral placeholder, never a wrong/flashing index
  // (loading ≠ unavailable, #158) — the buttons stay disabled until a real index is known.
  const displayIndex = isLoading && !data ? null : activeIndex;

  return (
    <div className="dig-index-nav" data-testid="index-navigator">
      <button
        type="button"
        className="dig-iconbtn"
        data-testid="index-nav-prev"
        aria-label={intl.formatMessage({ id: 'wallet.index.prev' })}
        title={intl.formatMessage({ id: 'wallet.index.prev' })}
        disabled={busy || displayIndex == null || displayIndex <= 0}
        onClick={() => void go(activeIndex - 1)}
      >
        ‹
      </button>

      {editing ? (
        <form onSubmit={submitJump} style={{ display: 'inline-flex' }}>
          <input
            className="dig-input"
            data-testid="index-nav-input"
            type="number"
            min={0}
            step={1}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitJump}
            aria-label={intl.formatMessage({ id: 'wallet.index.jump' })}
            style={{ width: 64 }}
          />
        </form>
      ) : (
        <button
          type="button"
          className="dig-index-nav-label"
          data-testid="index-nav-current"
          onClick={openJump}
          disabled={displayIndex == null}
          title={intl.formatMessage({ id: 'wallet.index.jump' })}
        >
          {displayIndex == null ? (
            <span aria-hidden="true">—</span>
          ) : (
            <FormattedMessage id="wallet.index.label" values={{ index: displayIndex }} />
          )}
        </button>
      )}

      <button
        type="button"
        className="dig-iconbtn"
        data-testid="index-nav-next"
        aria-label={intl.formatMessage({ id: 'wallet.index.next' })}
        title={intl.formatMessage({ id: 'wallet.index.next' })}
        disabled={busy || displayIndex == null}
        onClick={() => void go(activeIndex + 1)}
      >
        ›
      </button>

      {error && (
        <p className="dig-error-text" role="alert" data-testid="index-nav-error" style={{ margin: '4px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}
