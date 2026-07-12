import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { ExternalLink } from '@/components/ExternalLink';
import { useGetReceiveAddressQuery } from '@/features/wallet/custodyApi';
import { copyText } from '@/lib/clipboard';
import { isXchAddress, xchtipJarUrl, xchtipBuilderUrl, xchtipEmbedSnippet } from '@/lib/xchtip';

/** A small copy-to-clipboard button that flips to a transient "Copied" label. */
function CopyButton({ value, testid }: { value: string; testid: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="dig-btn dig-btn--sm"
      data-testid={testid}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <FormattedMessage id={copied ? 'tip.tab.xchtip.copied' : 'tip.tab.xchtip.copy'} />
    </button>
  );
}

/**
 * Generate an xchtip.app tip button for the user's OWN XCH address (#380, part 3) — so OTHERS can tip
 * THEM. Reuses the existing xchtip.app embeddable widget generator (#142/#185-188): a ready-to-share
 * hosted tip page, a copyable `<script>` embed snippet, and a "customize on xchtip.app" builder
 * deep-link. Node-independent (uses the local wallet's receive address); requires an unlocked wallet.
 */
export function XchtipButtonSection() {
  const intl = useIntl();
  const addrQuery = useGetReceiveAddressQuery();
  const address = addrQuery.data?.address ?? '';
  const hasAddress = isXchAddress(address);

  const jarUrl = hasAddress ? xchtipJarUrl(address) : null;
  const builderUrl = hasAddress ? xchtipBuilderUrl(address) : null;
  const embed = hasAddress ? xchtipEmbedSnippet(address) : null;

  return (
    <section className="dig-card" data-testid="tip-xchtip" aria-labelledby="tip-xchtip-title">
      <h3 className="dig-subheading" id="tip-xchtip-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.xchtip.title" />
      </h3>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="tip.tab.xchtip.subtitle" />
      </p>

      <FourState
        isLoading={addrQuery.isLoading}
        isError={addrQuery.isError}
        isEmpty={!hasAddress}
        onRetry={() => void addrQuery.refetch()}
        emptyId="tip.tab.xchtip.noWallet"
        testid="tip-xchtip"
      >
        {jarUrl && builderUrl && embed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Ready-to-share hosted tip page */}
            <div>
              <span className="dig-muted" style={{ fontSize: 12 }}>
                <FormattedMessage id="tip.tab.xchtip.link.label" />
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <input
                  className="dig-input"
                  data-testid="tip-xchtip-link"
                  type="text"
                  readOnly
                  value={jarUrl}
                  aria-label={intl.formatMessage({ id: 'tip.tab.xchtip.link.label' })}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ flex: 1, minWidth: 200, fontFamily: 'monospace', fontSize: 12 }}
                />
                <CopyButton value={jarUrl} testid="tip-xchtip-link-copy" />
                <ExternalLink href={jarUrl} className="dig-btn dig-btn--primary" testid="tip-xchtip-open">
                  <FormattedMessage id="tip.tab.xchtip.open" />
                </ExternalLink>
              </div>
            </div>

            {/* Copyable embed snippet */}
            <div>
              <span className="dig-muted" style={{ fontSize: 12 }}>
                <FormattedMessage id="tip.tab.xchtip.embed.label" />
              </span>
              <textarea
                className="dig-input"
                data-testid="tip-xchtip-embed"
                readOnly
                value={embed}
                rows={2}
                aria-label={intl.formatMessage({ id: 'tip.tab.xchtip.embed.label' })}
                onFocus={(e) => e.currentTarget.select()}
                style={{ width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <CopyButton value={embed} testid="tip-xchtip-embed-copy" />
                <ExternalLink href={builderUrl} className="dig-link" testid="tip-xchtip-builder">
                  <FormattedMessage id="tip.tab.xchtip.customize" />
                </ExternalLink>
              </div>
            </div>
          </div>
        )}
      </FourState>
    </section>
  );
}
