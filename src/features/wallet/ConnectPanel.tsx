import { FormattedMessage } from 'react-intl';
import { qrSvg } from '@/lib/qr';
import { useWalletConnect } from '@/features/wallet/useWalletConnect';

/**
 * The disconnected wallet's connect surface: a clear call to pair a Sage wallet. While pairing it
 * renders the WalletConnect `wc:` URI as a QR to scan; on failure it shows the honest error + a
 * retry. This is the "empty"/gateway state for every wallet view when no session exists.
 */
export function ConnectPanel() {
  const { phase, uri, error, connect } = useWalletConnect();

  return (
    <section className="dig-card" data-testid="wallet-connect" aria-labelledby="wallet-connect-title">
      <h2 className="dig-heading" id="wallet-connect-title">
        <FormattedMessage id="wallet.connect.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="wallet.connect.body" />
      </p>

      {phase === 'pairing' && uri && (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
          <div
            data-testid="wallet-connect-qr"
            aria-label="WalletConnect pairing QR code"
            role="img"
            dangerouslySetInnerHTML={{ __html: qrSvg(uri, 180) }}
          />
        </div>
      )}

      {phase === 'error' && (
        <p className="dig-error-text" role="alert" data-testid="wallet-connect-error">
          {error}
        </p>
      )}

      <button
        type="button"
        className="dig-btn dig-btn--primary dig-btn--block"
        data-testid="wallet-connect-cta"
        onClick={() => void connect()}
        disabled={phase === 'pairing'}
      >
        <FormattedMessage id={phase === 'pairing' ? 'wallet.connect.connecting' : 'wallet.connect.cta'} />
      </button>
    </section>
  );
}
