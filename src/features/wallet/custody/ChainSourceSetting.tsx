import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { custodyApi } from '@/features/wallet/custodyApi';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';
import { setChainSource } from '@/features/ui/uiSlice';
import {
  CHAIN_SOURCE_MODES,
  DEFAULT_CHAIN_SOURCE_MODE,
  isChainSourceMode,
  type ChainSourceMode,
} from '@/lib/wallet-source';

/** Every wallet-data view depends on the source, so a source change re-fetches them all (#217). */
const SOURCE_DEPENDENT_TAGS = ['Balances', 'Activity', 'Collectibles', 'Identity', 'Coins'] as const;

/**
 * User-facing wallet-data SOURCE switch (#217 EXT-2, design D.3) — the 4-state control that picks
 * where the wallet reads balances / tokens / NFTs / DIDs / coins / activity from:
 *
 *  - **Auto** (default): node-first per the §5.3 ladder, coinset.org fallback.
 *  - **dig-node RPC**: force the local dig-node's Sage-parity surface (error if unreachable).
 *  - **coinset.org**: force the public fallback.
 *  - **Custom URL**: point at a specific node RPC base (overrides the ladder entirely, §5.3).
 *
 * The selection persists to `wallet.settings` (read by the SW to resolve the source) and mirrors into
 * the `ui` slice for a synchronous read. Signing NEVER routes here — the dig-node is a read-only
 * chain-data source; the offscreen vault keeps every key (issue #217 HARD gate). Advanced-tier
 * surface, alongside the network + chain-node-override controls.
 */
export function ChainSourceSetting() {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const [mode, setMode] = useState<ChainSourceMode>(DEFAULT_CHAIN_SOURCE_MODE);
  const [customUrl, setCustomUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void readWalletSettings().then((s) => {
      if (!live) return;
      if (isChainSourceMode(s.chainSourceMode)) setMode(s.chainSourceMode);
      if (typeof s.chainSourceUrl === 'string') setCustomUrl(s.chainSourceUrl);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Persist the source selection, mirror it into the slice, and re-fetch every wallet-data view. */
  const persist = (nextMode: ChainSourceMode, nextUrl: string) => {
    void updateWalletSettings({ chainSourceMode: nextMode, chainSourceUrl: nextUrl }).then(() => {
      dispatch(setChainSource({ mode: nextMode, customUrl: nextUrl }));
      dispatch(custodyApi.util.invalidateTags([...SOURCE_DEPENDENT_TAGS]));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    });
  };

  const onModeChange = (next: ChainSourceMode) => {
    setMode(next);
    // A non-custom mode saves immediately; custom waits for a URL (saved via the field's blur/submit).
    if (next !== 'custom') persist(next, customUrl);
    else setSaved(false);
  };

  return (
    <div className="dig-card" data-testid="chain-source-setting">
      <label className="dig-field">
        <span id="chain-source-label">
          <FormattedMessage id="custody.source.label" />
        </span>
        <select
          className="dig-select"
          data-testid="chain-source-select"
          aria-labelledby="chain-source-label"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ChainSourceMode)}
        >
          {CHAIN_SOURCE_MODES.map((m) => (
            <option key={m} value={m}>
              {intl.formatMessage({ id: `custody.source.mode.${m}` })}
            </option>
          ))}
        </select>
      </label>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id={`custody.source.hint.${mode}`} />
      </p>

      {mode === 'custom' && (
        <form
          className="dig-field"
          data-testid="chain-source-custom"
          onSubmit={(e) => {
            e.preventDefault();
            persist('custom', customUrl.trim());
          }}
        >
          <label className="dig-field">
            <span id="chain-source-url-label">
              <FormattedMessage id="custody.source.custom.label" />
            </span>
            <input
              className="dig-input"
              data-testid="chain-source-url"
              aria-labelledby="chain-source-url-label"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onBlur={() => persist('custom', customUrl.trim())}
              placeholder="http://my-node:9778"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          <button type="submit" className="dig-btn dig-btn--block" data-testid="chain-source-save">
            <FormattedMessage id="custody.source.custom.save" />
          </button>
        </form>
      )}

      {saved && (
        <p className="dig-muted" role="status" data-testid="chain-source-saved" style={{ marginTop: 8 }}>
          <FormattedMessage id="custody.source.saved" />
        </p>
      )}
    </div>
  );
}
