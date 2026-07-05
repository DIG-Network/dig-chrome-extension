import { useEffect, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';

/**
 * One-time balance-scan privacy disclosure (§7.1): balance/activity scans query the configured chain
 * operator (coinset.org by default) with the wallet's full HD puzzle-hash set, linking them to one
 * operator. Shown until the user acknowledges (persisted to `wallet.settings.chainPrivacyAck`); a
 * privacy-minded user can point at their own node via {@link ChainNodeSetting}.
 */
export function PrivacyNote() {
  const [ack, setAck] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void readWalletSettings().then((s) => live && setAck(!!s.chainPrivacyAck));
    return () => {
      live = false;
    };
  }, []);

  if (ack !== false) return null; // loading (null) or already acknowledged (true) → hide

  return (
    <section className="dig-card" role="note" data-testid="privacy-note" aria-labelledby="privacy-note-title">
      <h3 className="dig-heading" id="privacy-note-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.privacy.title" />
      </h3>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.privacy.body" />
      </p>
      <button
        type="button"
        className="dig-btn dig-btn--block"
        data-testid="privacy-ack"
        onClick={() => {
          void updateWalletSettings({ chainPrivacyAck: true });
          setAck(true);
        }}
      >
        <FormattedMessage id="custody.privacy.ack" />
      </button>
    </section>
  );
}
