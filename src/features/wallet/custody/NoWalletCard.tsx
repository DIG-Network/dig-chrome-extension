import { FormattedMessage } from 'react-intl';
import { popOutToFullpage } from '@/lib/popout';

/**
 * The compact (popup) no-wallet CTA (Fable #7: onboarding lives in fullscreen). Instead of cramming
 * the create/import flow into ~360px, the popup shows one card that opens `app.html#wallet` where the
 * full onboarding runs. A secondary path keeps the Sage-broker connect available.
 */
export function NoWalletCard({ onUseSage }: { onUseSage?: () => void }) {
  return (
    <section className="dig-card" data-testid="custody-nowallet" aria-labelledby="nowallet-title">
      <h2 className="dig-heading" id="nowallet-title">
        <FormattedMessage id="custody.nowallet.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="custody.nowallet.body" />
      </p>
      <button
        type="button"
        className="dig-btn dig-btn--primary dig-btn--block"
        data-testid="nowallet-setup"
        onClick={() => void popOutToFullpage('#wallet', true)}
      >
        <FormattedMessage id="custody.nowallet.setup" />
      </button>
      {onUseSage && (
        <button type="button" className="dig-link" data-testid="nowallet-sage" onClick={onUseSage}>
          <FormattedMessage id="custody.onboarding.useSage" />
        </button>
      )}
    </section>
  );
}
