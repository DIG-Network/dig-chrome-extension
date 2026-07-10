import { useState } from 'react';
import { FormattedMessage, FormattedDate, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import {
  useGetCacheStatsQuery,
  useListCachedQuery,
  useSetCacheCapMutation,
  useRemoveCachedMutation,
  useClearCacheMutation,
} from '@/features/control/cacheApi';
import { cacheStatsView, cachedEntriesView, parseCapToBytes, type CapUnit } from '@/lib/dig-cache';

/**
 * The HEADLINE cache/LRU management section (#279/#281) — OPEN `cache.*`, no pairing needed.
 * Shows the reserved-cap usage bar, a "set reserved cap" control (floored 64 MiB), the session
 * telemetry line, and the cached-capsule list in LRU order (rank 0 = next evicted) with per-entry
 * evict + a clear-all. Every mutation invalidates the `Cache` tag so the whole section refreshes.
 */
export function CacheSection() {
  const intl = useIntl();
  const stats = useGetCacheStatsQuery();
  const list = useListCachedQuery();
  const [setCap, setCapState] = useSetCacheCapMutation();
  const [removeCached] = useRemoveCachedMutation();
  const [clearCache, clearState] = useClearCacheMutation();

  const [capValue, setCapValue] = useState('');
  const [capUnit, setCapUnit] = useState<CapUnit>('MiB');
  const [capError, setCapError] = useState(false);

  const sv = cacheStatsView(stats.data);
  const entries = cachedEntriesView(list.data?.cached);

  const applyCap = () => {
    const bytes = parseCapToBytes(capValue, capUnit);
    if (bytes == null) {
      setCapError(true);
      return;
    }
    setCapError(false);
    void setCap({ capBytes: bytes })
      .unwrap()
      .then(() => setCapValue(''))
      .catch(() => {});
  };

  return (
    <section className="dig-card" data-testid="control-cache" aria-labelledby="control-cache-title">
      <h3 className="dig-heading" id="control-cache-title">
        <FormattedMessage id="control.cache.title" />
      </h3>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="control.cache.desc" />
      </p>

      {/* Usage bar */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="dig-muted" data-testid="control-cache-usage">
            <FormattedMessage
              id="control.cache.usage"
              values={{ used: sv.usedLabel, cap: sv.capLabel, pct: String(sv.usagePercent) }}
            />
          </span>
        </div>
        <div
          className="dig-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={sv.usagePercent}
          aria-label={intl.formatMessage({ id: 'control.cache.usage.aria' })}
          style={{ background: 'var(--dig-track, #2223)', borderRadius: 6, height: 8, overflow: 'hidden' }}
        >
          <div
            data-testid="control-cache-bar-fill"
            style={{ width: `${sv.usagePercent}%`, height: '100%', background: 'var(--dig-accent, #5b8cff)' }}
          />
        </div>
      </div>

      {/* Set reserved cap */}
      <div className="dig-row" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="dig-muted">
            <FormattedMessage id="control.cache.setCap.label" />
          </span>
          <input
            type="number"
            min="64"
            inputMode="numeric"
            className="dig-input"
            data-testid="control-cache-cap-input"
            value={capValue}
            onChange={(e) => setCapValue(e.target.value)}
            aria-label={intl.formatMessage({ id: 'control.cache.setCap.label' })}
            aria-invalid={capError}
            style={{ width: 120 }}
          />
        </label>
        <select
          className="dig-input"
          data-testid="control-cache-cap-unit"
          value={capUnit}
          onChange={(e) => setCapUnit(e.target.value as CapUnit)}
          aria-label={intl.formatMessage({ id: 'control.cache.setCap.unit' })}
        >
          <option value="MiB">MiB</option>
          <option value="GiB">GiB</option>
        </select>
        <button
          type="button"
          className="dig-btn dig-btn--primary"
          data-testid="control-cache-cap-apply"
          onClick={applyCap}
          disabled={setCapState.isLoading}
        >
          <FormattedMessage id="control.cache.setCap.apply" />
        </button>
      </div>
      {capError && (
        <p className="dig-muted" data-testid="control-cache-cap-error" role="alert" style={{ color: 'var(--dig-bad, #e55)' }}>
          <FormattedMessage id="control.cache.setCap.error" />
        </p>
      )}

      {/* Session telemetry */}
      <p className="dig-muted" data-testid="control-cache-stats" style={{ marginBottom: 12 }}>
        <FormattedMessage
          id="control.cache.stats"
          values={{
            entries: String(sv.entryCount),
            total: sv.totalLabel,
            evicted: String(sv.evictedCount),
            evictedBytes: sv.evictedLabel,
            hitRate: sv.hitRatePercent == null ? '—' : `${sv.hitRatePercent}%`,
          }}
        />
      </p>

      {/* Cached entry list (LRU order) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h4 className="dig-subheading" style={{ margin: 0 }}>
          <FormattedMessage id="control.cache.list.title" />
        </h4>
        <button
          type="button"
          className="dig-btn dig-btn--danger"
          data-testid="control-cache-clear"
          onClick={() => void clearCache()}
          disabled={clearState.isLoading || entries.length === 0}
        >
          <FormattedMessage id="control.cache.clearAll" />
        </button>
      </div>
      <FourState
        isLoading={list.isLoading}
        isError={list.isError}
        isEmpty={entries.length === 0}
        onRetry={() => void list.refetch()}
        emptyId="control.cache.list.empty"
        testid="control-cache-list"
      >
        <ul className="dig-list" data-testid="control-cache-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((e) => (
            <li
              key={e.key}
              className="dig-row"
              data-testid="control-cache-entry"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dig-border, #3333)' }}
            >
              <span className="dig-pill" data-tone="neutral" title="LRU rank (0 = next evicted)">
                #{e.lruRank}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }} title={e.capsule}>
                  {e.capsule}
                </div>
                <div className="dig-muted" style={{ fontSize: 12 }}>
                  {e.sizeLabel}
                  {e.lastUsedUnixMs > 0 && (
                    <>
                      {' · '}
                      <FormattedDate value={e.lastUsedUnixMs} dateStyle="short" timeStyle="short" />
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="dig-btn dig-btn--sm"
                data-testid="control-cache-evict"
                onClick={() => void removeCached({ storeId: e.storeId, root: e.root })}
                aria-label={intl.formatMessage({ id: 'control.cache.evict' })}
              >
                <FormattedMessage id="control.cache.evict" />
              </button>
            </li>
          ))}
        </ul>
      </FourState>
    </section>
  );
}
