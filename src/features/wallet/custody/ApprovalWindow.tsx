import { useEffect } from 'react';
import { FormattedMessage, IntlProvider, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { UnlockScreen } from '@/features/wallet/custody/UnlockScreen';
import { useAppSelector } from '@/app/hooks';
import { messagesFor, DEFAULT_LOCALE } from '@/i18n';
import {
  useGetDappApprovalQueueQuery,
  useResolveDappApprovalMutation,
  type DappApprovalRequest,
  type DappMessageSummary,
} from '@/features/wallet/custody/approvalApi';
import type { DappSpendSummary } from '@/offscreen/dappSign';

/**
 * {@link ApprovalWindow} wrapped in the react-intl provider bound to the store's active locale. The
 * entry supplies the Redux `<Provider>`; kept here (not in the thin entry) so the entry stays free of
 * component definitions (react-refresh) and unit tests can render {@link ApprovalWindow} directly.
 */
export function ApprovalRoot() {
  const locale = useAppSelector((s) => s.ui.locale);
  return (
    <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(locale)}>
      <ApprovalWindow />
    </IntlProvider>
  );
}

/**
 * The SW-summoned dApp approval window (#56 §5.5) — the trusted, dedicated surface a webpage's
 * `window.chia` sign/spend request is reviewed in. It reads the pending queue (polled so a freshly
 * summoned request and a post-unlock decode appear), renders a tamper-resistant summary decoded FROM
 * THE BUILT SPEND (never page text), and returns the user's approve/reject decision to the service
 * worker (approve → the offscreen vault signs; the key never leaves it). One request at a time; the
 * window self-closes when the queue drains. A keepalive port keeps the SW + vault alive through review.
 */
export function ApprovalWindow() {
  useKeepalive();
  const { data, isLoading, isError, refetch } = useGetDappApprovalQueueQuery(undefined, { pollingInterval: 1500 });
  const requests = data?.requests ?? [];
  const current = requests[0] ?? null;

  // Dedicated dApp window: once the queue drains, close it (a brief delay avoids flicker between items).
  useEffect(() => {
    if (data && requests.length === 0) {
      const t = setTimeout(() => {
        try {
          window.close();
        } catch {
          /* window.close may be a no-op (tests) */
        }
      }, 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [data, requests.length]);

  return (
    <main className="dig-screen" data-testid="approval-window" aria-labelledby="approval-title">
      <header className="dig-header" style={{ marginBottom: 12 }}>
        <h1 className="dig-heading" id="approval-title">
          <FormattedMessage id="dapp.approval.title" />
        </h1>
        <p className="dig-muted" style={{ margin: 0 }}>
          <FormattedMessage id="dapp.approval.subtitle" />
        </p>
      </header>
      <FourState
        isLoading={isLoading && !data}
        isError={isError}
        isEmpty={!!data && requests.length === 0}
        onRetry={refetch}
        testid="approval"
        loadingId="dapp.approval.loading"
        errorId="dapp.approval.error"
        emptyId="dapp.approval.empty"
      >
        {current && <ApprovalRequestCard key={current.id} request={current} pending={requests.length} />}
      </FourState>
    </main>
  );
}

/** Render + decide a single pending request. */
function ApprovalRequestCard({ request, pending }: { request: DappApprovalRequest; pending: number }) {
  const [resolve, state] = useResolveDappApprovalMutation();
  const busy = state.isLoading;
  const decide = (approved: boolean) => void resolve({ id: request.id, approved });

  return (
    <section className="dig-card" data-testid="approval-request" aria-labelledby="approval-req-title">
      <p className="dig-muted" style={{ margin: '0 0 4px' }}>
        <FormattedMessage id="dapp.approval.origin.label" />
      </p>
      <p className="dig-mono" data-testid="approval-origin" style={{ margin: '0 0 12px', fontWeight: 600, wordBreak: 'break-all' }}>
        {request.origin}
      </p>

      {request.needsUnlock ? (
        <div data-testid="approval-locked">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="dapp.approval.locked.note" />
          </p>
          <UnlockScreen />
        </div>
      ) : request.decodeError ? (
        <p className="dig-error-text" role="alert" data-testid="approval-decode-error">
          <FormattedMessage id="dapp.approval.decodeError" />
        </p>
      ) : request.kind === 'signCoinSpends' ? (
        <SpendSummaryView summary={request.summary as DappSpendSummary | null} />
      ) : (
        <MessageSummaryView summary={request.summary as DappMessageSummary | null} />
      )}

      {pending > 1 && (
        <p className="dig-muted" data-testid="approval-queue-count" style={{ marginTop: 12 }}>
          <FormattedMessage id="dapp.approval.queueCount" values={{ count: pending - 1 }} />
        </p>
      )}
      {state.isError && (
        <p className="dig-error-text" role="alert" data-testid="approval-resolve-error">
          <FormattedMessage id="dapp.approval.resolveError" />
        </p>
      )}

      <div className="dig-actionbar" style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          type="button"
          className="dig-btn dig-btn--ghost dig-btn--block"
          data-testid="approval-reject"
          onClick={() => decide(false)}
          disabled={busy}
        >
          <FormattedMessage id="dapp.approval.reject" />
        </button>
        {!request.decodeError && (
          <button
            type="button"
            className="dig-btn dig-btn--primary dig-btn--block"
            data-testid="approval-approve"
            onClick={() => decide(true)}
            disabled={busy || request.needsUnlock}
          >
            <FormattedMessage id={busy ? 'dapp.approval.working' : 'dapp.approval.approve'} />
          </button>
        )}
      </div>
    </section>
  );
}

/** Mojos (decimal string) → a trimmed XCH string. */
function xch(mojos: string): string {
  const n = Number(mojos) / 1e12;
  return n.toLocaleString(undefined, { maximumFractionDigits: 12 });
}

/** Truncate a long hex id/address for display (keeps head + tail). */
function short(hex: string): string {
  return hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex;
}

/** The decoded coin-spend summary — the tamper-resistant facts the user authorizes. */
function SpendSummaryView({ summary }: { summary: DappSpendSummary | null }) {
  const intl = useIntl();
  if (!summary) {
    return (
      <p className="dig-muted" data-testid="approval-no-summary">
        <FormattedMessage id="dapp.approval.decodeError" />
      </p>
    );
  }
  const fullySignable = summary.ownedSigners >= summary.requiredSigners.length && summary.requiredSigners.length > 0;
  return (
    <div data-testid="approval-spend-summary">
      <h2 className="dig-section-title" id="approval-req-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="dapp.approval.sign.title" />
      </h2>

      {summary.allInputsSelf ? (
        <dl className="dig-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, margin: '8px 0' }}>
          <dt className="dig-muted"><FormattedMessage id="dapp.approval.sending" /></dt>
          <dd className="dig-mono" data-testid="approval-sending" style={{ margin: 0, textAlign: 'right' }}>{xch(summary.sendingMojos)} XCH</dd>
          <dt className="dig-muted"><FormattedMessage id="dapp.approval.change" /></dt>
          <dd className="dig-mono" data-testid="approval-change" style={{ margin: 0, textAlign: 'right' }}>{xch(summary.changeMojos)} XCH</dd>
          <dt className="dig-muted"><FormattedMessage id="dapp.approval.fee" /></dt>
          <dd className="dig-mono" data-testid="approval-fee" style={{ margin: 0, textAlign: 'right' }}>{xch(summary.feeMojos)} XCH</dd>
        </dl>
      ) : (
        <p className="dig-muted" data-testid="approval-advanced-note" style={{ margin: '8px 0' }}>
          <FormattedMessage id="dapp.approval.advancedNote" />
        </p>
      )}

      <p className="dig-muted" data-testid="approval-signatures" style={{ margin: '8px 0' }}>
        <FormattedMessage id="dapp.approval.signatures" values={{ count: summary.requiredSigners.length }} />
      </p>

      {!fullySignable && (
        <p className="dig-error-text" role="alert" data-testid="approval-cannot-sign">
          <FormattedMessage id="dapp.approval.cannotSign" />
        </p>
      )}

      {summary.outputs.length > 0 && (
        <details data-testid="approval-outputs">
          <summary>{intl.formatMessage({ id: 'dapp.approval.outputs.title' }, { count: summary.outputs.length })}</summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
            {summary.outputs.map((o, i) => (
              <li key={`${o.puzzleHash}-${i}`} className="dig-mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
                <span style={{ wordBreak: 'break-all' }}>
                  {short(o.puzzleHash)}{' '}
                  <span className={o.isSelf ? 'dig-pill dig-pill--ok' : 'dig-pill dig-pill--warn'}>
                    <FormattedMessage id={o.isSelf ? 'dapp.approval.output.self' : 'dapp.approval.output.external'} />
                  </span>
                </span>
                <span>{xch(o.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The decoded message-signing summary — the exact message + the signer key. */
function MessageSummaryView({ summary }: { summary: DappMessageSummary | null }) {
  return (
    <div data-testid="approval-message-summary">
      <h2 className="dig-section-title" id="approval-req-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="dapp.approval.message.title" />
      </h2>
      <p className="dig-muted" style={{ margin: '8px 0 4px' }}>
        <FormattedMessage id="dapp.approval.message.label" />
      </p>
      <pre
        className="dig-mono"
        data-testid="approval-message"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,0,0,0.04)', padding: 10, borderRadius: 8, margin: 0 }}
      >
        {summary?.message ?? ''}
      </pre>
      {summary?.publicKey && (
        <p className="dig-muted dig-mono" data-testid="approval-signed-as" style={{ marginTop: 8, wordBreak: 'break-all' }}>
          <FormattedMessage id="dapp.approval.message.signedAs" values={{ key: short(summary.publicKey) }} />
        </p>
      )}
    </div>
  );
}

/**
 * Hold a keepalive port to the service worker while the window is open. A connected port (pinged
 * periodically) keeps the MV3 SW — and thus the offscreen vault + the pending request — alive
 * through the review. A no-op where `chrome.runtime.connect` is unavailable (unit tests).
 */
function useKeepalive() {
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.connect !== 'function') return undefined;
    let port: chrome.runtime.Port | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      port = chrome.runtime.connect({ name: 'dapp-approval-keepalive' });
      const ping = () => {
        try {
          port?.postMessage({ ping: Date.now() });
        } catch {
          /* port closing */
        }
      };
      ping();
      timer = setInterval(ping, 20000);
    } catch {
      /* connect unavailable */
    }
    return () => {
      if (timer) clearInterval(timer);
      try {
        port?.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }, []);
}
