import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { qrSvg } from '@/lib/qr';
import { shortenAddress } from '@/lib/wallet-view';
import { ViewHeader } from '@/components/ViewHeader';

/**
 * The Receive SCREEN (§6 Receive, #166): opened from the Assets view's "Receive" action, this is
 * its ENTIRE content — a sticky `ViewHeader` (back to Assets) followed immediately by the QR +
 * address + copy. Because nothing else shares this screen (no asset/CAT list above or beside it),
 * the QR/address are reachable with zero scrolling no matter how many CATs the wallet holds — the
 * #166 fix for "Receive buried below the CAT list". Local (no network), so it has no loading/error
 * network states; when no address is available it shows a real empty state (the header + back
 * still work, so the user isn't stranded on it).
 */
export function ReceiveView({ address, onBack }: { address: string | undefined; onBack?: () => void }) {
  const [copied, setCopied] = useState(false);

  const header = (
    <ViewHeader
      onBack={onBack}
      backLabel={<FormattedMessage id="receive.back" />}
      backTestId="receive-close"
      title={<FormattedMessage id="receive.title" />}
      titleId="receive-title"
    />
  );

  if (!address) {
    return (
      <div data-testid="wallet-receive-screen">
        {header}
        <div className="dig-state" data-state="empty" data-testid="receive-empty">
          <FormattedMessage id="receive.empty" />
        </div>
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
    <div data-testid="wallet-receive-screen">
      {header}
      <section className="dig-card" data-testid="wallet-receive" aria-labelledby="receive-title">
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
      </section>
    </div>
  );
}
