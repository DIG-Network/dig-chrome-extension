import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useAppDispatch } from '@/app/hooks';
import { custodyApi } from '@/features/wallet/custodyApi';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';
import { setChainNetwork } from '@/features/ui/uiSlice';
import { NETWORK_IDS, DEFAULT_NETWORK_ID, isNetworkId, type NetworkId } from '@/lib/network';

/** Reads/activity that depend on which chain network is selected — re-fetched on a confirmed switch. */
const NETWORK_DEPENDENT_TAGS = ['Balances', 'Activity', 'Address', 'Collectibles', 'Coins'] as const;

/**
 * User-facing mainnet/testnet switcher (#108, §5.3-adjacent: this is the network choice, not the
 * node-URL override — see {@link ChainNodeSetting}). A network change alters which chain reads
 * resolve against (`resolveCoinsetUrl`, `src/lib/custody-session.ts`) — a two-step confirm is
 * required before it takes effect, because mainnet holds real funds and a user must never
 * accidentally leave it (or mistake a testnet balance for a real one). Advanced-tier surface,
 * alongside the chain-node override (the everyday user never needs it).
 */
export function NetworkSetting() {
  const dispatch = useAppDispatch();
  const intl = useIntl();
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK_ID);
  const [pending, setPending] = useState<NetworkId | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void readWalletSettings().then((s) => {
      if (live && isNetworkId(s.network)) setNetwork(s.network);
    });
    return () => {
      live = false;
    };
  }, []);

  const requestSwitch = (next: NetworkId) => {
    setSaved(false);
    if (next === network) {
      setPending(null);
      return;
    }
    setPending(next);
  };

  const confirmSwitch = () => {
    if (!pending) return;
    const next = pending;
    void updateWalletSettings({ network: next }).then(() => {
      setNetwork(next);
      setPending(null);
      dispatch(setChainNetwork(next));
      dispatch(custodyApi.util.invalidateTags([...NETWORK_DEPENDENT_TAGS]));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="dig-card" data-testid="network-setting">
      <label className="dig-field">
        <span>
          <FormattedMessage id="custody.network.label" />
        </span>
        <select
          className="dig-select"
          data-testid="network-select"
          value={pending ?? network}
          onChange={(e) => requestSwitch(e.target.value as NetworkId)}
        >
          {NETWORK_IDS.map((id) => (
            <option key={id} value={id}>
              {intl.formatMessage({ id: `custody.network.${id}` })}
            </option>
          ))}
        </select>
      </label>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.network.hint" />
      </p>
      {pending && (
        <div className="dig-banner dig-banner--warn" style={{ padding: 12 }} data-testid="network-confirm">
          <p style={{ margin: '0 0 10px' }}>
            <FormattedMessage
              id="custody.network.confirmPrompt"
              values={{ network: intl.formatMessage({ id: `custody.network.${pending}` }) }}
            />
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dig-btn dig-btn--primary" data-testid="network-confirm-proceed" onClick={confirmSwitch}>
              <FormattedMessage id="custody.network.confirmProceed" />
            </button>
            <button type="button" className="dig-btn" data-testid="network-confirm-cancel" onClick={() => setPending(null)}>
              <FormattedMessage id="custody.network.confirmCancel" />
            </button>
          </div>
        </div>
      )}
      {saved && !pending && (
        <p className="dig-muted" data-testid="network-saved" style={{ marginTop: 8 }}>
          <FormattedMessage id="custody.network.saved" />
        </p>
      )}
    </div>
  );
}
