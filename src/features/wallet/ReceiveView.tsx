import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { qrSvg } from '#shared/qr.mjs';
import { shortenAddress } from '#shared/wallet-view.mjs';

/**
 * The Receive view (§6 Receive): the wallet's address as text + a QR + copy. Local (no network),
 * so it has no loading/error network states; when no address is available it shows a real empty
 * state pointing back to Connect.
 */
export function ReceiveView({ address }: { address: string | undefined }) {
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <div className="dig-state" data-state="empty" data-testid="receive-empty">
        <FormattedMessage id="receive.empty" />
      </div>
    );
  }

  const onCopy = () => {
    // Optional-chain the promise too — jsdom / older contexts may lack navigator.clipboard.
    navigator.clipboard?.writeText(address)?.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };

  return (
    <div data-testid="wallet-receive">
      <div className="dig-qr-wrap">
        <div role="img" aria-label="Receive address QR code" dangerouslySetInnerHTML={{ __html: qrSvg(address, 180) }} />
      </div>
      <div className="dig-field">
        <label htmlFor="receive-address">
          <FormattedMessage id="receive.your.address" />
        </label>
        <input
          id="receive-address"
          className="dig-input dig-mono"
          data-testid="wallet-address"
          readOnly
          value={address}
          aria-label={shortenAddress(address)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <button type="button" className="dig-btn dig-btn--block" data-testid="receive-copy" onClick={onCopy}>
        <FormattedMessage id={copied ? 'receive.copied' : 'receive.copy'} />
      </button>
    </div>
  );
}
