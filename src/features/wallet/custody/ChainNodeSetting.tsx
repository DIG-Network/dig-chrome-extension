import { useEffect, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { custodyApi } from '@/features/wallet/custodyApi';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';

/**
 * User-facing chain-RPC override (§5.3: a custom node MUST be settable + persisted on every client).
 * Empty → the SW uses the coinset.org default. Saving invalidates the balance cache so the next scan
 * uses the new endpoint. Advanced-tier surface (the everyday user never needs it).
 */
export function ChainNodeSetting() {
  const dispatch = useAppDispatch();
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void readWalletSettings().then((s) => live && setUrl(s.chainRpcUrl ?? ''));
    return () => {
      live = false;
    };
  }, []);

  return (
    <form
      className="dig-card"
      data-testid="chain-node-setting"
      onSubmit={(e) => {
        e.preventDefault();
        void updateWalletSettings({ chainRpcUrl: url.trim() }).then(() => {
          setSaved(true);
          dispatch(custodyApi.util.invalidateTags(['Balances']));
          window.setTimeout(() => setSaved(false), 2000);
        });
      }}
    >
      <label className="dig-field">
        <span>
          <FormattedMessage id="custody.chain.label" />
        </span>
        <input
          className="dig-input"
          data-testid="chain-node-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.coinset.org"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.chain.hint" />
      </p>
      <button type="submit" className="dig-btn dig-btn--block" data-testid="chain-node-save">
        <FormattedMessage id={saved ? 'custody.chain.saved' : 'custody.chain.save'} />
      </button>
    </form>
  );
}
