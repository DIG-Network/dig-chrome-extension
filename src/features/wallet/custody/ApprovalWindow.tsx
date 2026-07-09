import { useEffect, useState } from 'react';
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
  type DappSendSummary,
  type DappOfferSummary,
} from '@/features/wallet/custody/approvalApi';
import type { DappSpendSummary } from '@/offscreen/dappSign';
import { assessSpendRisk, type SpendRisk } from '@/lib/spend-risk';
import type { OriginRisk } from '@/lib/phishing';
import { formatBaseUnits } from '@/lib/wallet-view';
import { useGetPricesQuery } from '@/features/wallet/priceApi';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { resolveCatMeta, type CatMetaMap } from '@/features/wallet/catMetadata';
import type { PriceMap } from '@/features/wallet/priceTypes';
import { xchMojosToUsd, catBaseUnitsToUsd } from '@/features/wallet/custody/approvalFiat';
import { FiatEquivalent } from '@/features/wallet/custody/FiatEquivalent';

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
  // #77 — fiat equivalents + resolved CAT names. Both are SEPARATE, public, non-sensitive api
  // slices (the SAME ones the wallet's own balances view reads) — a price/registry outage never
  // blocks review; the summary views below degrade gracefully (no fiat line, generic CAT ticker).
  const prices = useGetPricesQuery().data ?? {};
  const catRegistry = useGetCatRegistryQuery().data;

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
        {current && (
          <ApprovalRequestCard key={current.id} request={current} pending={requests.length} prices={prices} catRegistry={catRegistry} />
        )}
      </FourState>
    </main>
  );
}

/** Render + decide a single pending request. */
function ApprovalRequestCard({
  request,
  pending,
  prices,
  catRegistry,
}: {
  request: DappApprovalRequest;
  pending: number;
  prices: PriceMap;
  catRegistry?: CatMetaMap;
}) {
  const [resolve, state] = useResolveDappApprovalMutation();
  const [ack, setAck] = useState(false);
  const busy = state.isLoading;
  const decide = (approved: boolean) => void resolve({ id: request.id, approved });

  // Phishing/lookalike verdict for the requesting origin (#67 P0-2). A blocked origin is refused
  // (reject-only, no summary shown); a lookalike must be acknowledged before Approve.
  const originRisk = request.originRisk;
  const originBlocked = originRisk?.verdict === 'block';
  const originWarn = originRisk?.verdict === 'warn';

  // Anti-drainer risk assessment (#67 P0-3), derived from the tamper-resistant decoded summary (never
  // page text). Only dApp-BUILT coin-spend requests (signCoinSpends + sendTransaction's bundle) carry
  // spend risk — a wallet-built send/offer's summary IS the explicit request; a locked/undecodable
  // request has no summary.
  const isDappSpend = request.kind === 'signCoinSpends' || request.kind === 'sendTransaction';
  const reviewable = isDappSpend && !request.needsUnlock && !request.decodeError && !originBlocked;
  const risk: SpendRisk = reviewable
    ? assessSpendRisk(request.summary as DappSpendSummary | null)
    : { level: 'none', findings: [], requiresExtraConfirm: false };
  const needsAck = risk.requiresExtraConfirm || originWarn;
  const blockedOnAck = needsAck && !ack;
  // The summary is built asynchronously (a send/offer build scans the chain); while it streams in the
  // request shows a "preparing" state and Approve is held — a null summary is NOT yet an error.
  const preparing = !originBlocked && !request.needsUnlock && !request.decodeError && request.summary == null;
  const canApprove = !request.decodeError && !originBlocked;

  return (
    <section className="dig-card" data-testid="approval-request" aria-labelledby="approval-req-title">
      <p className="dig-muted" style={{ margin: '0 0 4px' }}>
        <FormattedMessage id="dapp.approval.origin.label" />
      </p>
      <p className="dig-mono" data-testid="approval-origin" style={{ margin: '0 0 12px', fontWeight: 600, wordBreak: 'break-all' }}>
        {request.origin}
      </p>

      {originRisk && originRisk.verdict !== 'ok' && <OriginRiskBanner risk={originRisk} />}

      {originBlocked ? (
        <p className="dig-error-text" role="alert" data-testid="approval-origin-blocked">
          <FormattedMessage id="dapp.approval.phishing.blocked.note" />
        </p>
      ) : request.needsUnlock ? (
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
      ) : preparing ? (
        <p className="dig-muted" role="status" aria-live="polite" data-testid="approval-preparing">
          <FormattedMessage id="dapp.approval.loading" />
        </p>
      ) : isDappSpend ? (
        <SpendSummaryView summary={request.summary as DappSpendSummary | null} prices={prices} />
      ) : request.kind === 'send' ? (
        <SendSummaryView summary={request.summary as DappSendSummary | null} prices={prices} catRegistry={catRegistry} />
      ) : request.kind === 'createOffer' || request.kind === 'takeOffer' || request.kind === 'cancelOffer' ? (
        <OfferSummaryView summary={request.summary as DappOfferSummary | null} prices={prices} catRegistry={catRegistry} />
      ) : (
        <MessageSummaryView summary={request.summary as DappMessageSummary | null} />
      )}

      {/* #77 — an expandable raw view of the exact decoded facts, for a reviewer who wants the full
          detail beyond the human summary above. Available whenever there IS a summary to show. */}
      {!originBlocked && !request.needsUnlock && !request.decodeError && !preparing && <RawDetails data={request.summary} />}

      {reviewable && risk.findings.length > 0 && <RiskBanner risk={risk} />}

      {!originBlocked && needsAck && (
        <label className="dig-check" data-testid="approval-risk-ack" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="approval-risk-ack-input" />
          <span className="dig-muted">
            <FormattedMessage id={originWarn ? 'dapp.approval.phishing.confirm' : 'dapp.approval.risk.confirm'} />
          </span>
        </label>
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
        {canApprove && (
          <button
            type="button"
            className={`dig-btn dig-btn--block ${risk.level === 'high' || originWarn ? 'dig-btn--danger' : 'dig-btn--primary'}`}
            data-testid="approval-approve"
            onClick={() => decide(true)}
            disabled={busy || request.needsUnlock || blockedOnAck || preparing}
          >
            <FormattedMessage id={busy ? 'dapp.approval.working' : 'dapp.approval.approve'} />
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The phishing / malicious-origin interstitial (#67 P0-2). A `block` verdict (the origin is on the
 * DIG blocklist) is a hard danger banner; a `warn` verdict (a lookalike of a real DIG surface) is a
 * caution the user must acknowledge. `role="alert"` announces it to assistive tech.
 */
function OriginRiskBanner({ risk }: { risk: OriginRisk }) {
  const blocked = risk.verdict === 'block';
  const reasonId = risk.reason === 'BLOCKLISTED' ? 'dapp.approval.phishing.reason.blocklisted' : 'dapp.approval.phishing.reason.lookalike';
  return (
    <div
      role="alert"
      data-testid="approval-origin-risk"
      data-origin-verdict={risk.verdict}
      className={blocked ? 'dig-banner dig-banner--danger' : 'dig-banner dig-banner--warn'}
      style={{ marginTop: 12, marginBottom: 4, padding: 12, borderRadius: 8 }}
    >
      <p className="dig-section-title dig-error-text" style={{ margin: '0 0 6px' }}>
        <FormattedMessage id={blocked ? 'dapp.approval.phishing.title.blocked' : 'dapp.approval.phishing.title.warn'} />
      </p>
      <p className="dig-muted" style={{ margin: 0 }}>
        <FormattedMessage id={reasonId} />
      </p>
    </div>
  );
}

/**
 * The anti-drainer risk banner (#67 P0-3). Renders each finding of the tamper-resistant risk
 * assessment as a plain-language warning; `role="alert"` announces it to assistive tech. High risk
 * uses the error style; a caution-only assessment uses the warn style.
 */
function RiskBanner({ risk }: { risk: SpendRisk }) {
  return (
    <div
      role="alert"
      data-testid="approval-risk"
      data-risk-level={risk.level}
      className={risk.level === 'high' ? 'dig-banner dig-banner--danger' : 'dig-banner dig-banner--warn'}
      style={{ marginTop: 12, padding: 12, borderRadius: 8 }}
    >
      <p className="dig-section-title" style={{ margin: '0 0 6px' }}>
        <FormattedMessage id={risk.level === 'high' ? 'dapp.approval.risk.title.high' : 'dapp.approval.risk.title.caution'} />
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {risk.findings.map((f) => (
          <li key={f.code} data-testid={`approval-risk-${f.code}`} className={f.severity === 'high' ? 'dig-error-text' : 'dig-muted'}>
            <FormattedMessage id={`dapp.approval.risk.${f.code}`} />
          </li>
        ))}
      </ul>
    </div>
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
function SpendSummaryView({ summary, prices }: { summary: DappSpendSummary | null; prices: PriceMap }) {
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
          <dd className="dig-mono" data-testid="approval-sending" style={{ margin: 0, textAlign: 'right' }}>
            {xch(summary.sendingMojos)} XCH<FiatEquivalent usd={xchMojosToUsd(summary.sendingMojos, prices)} />
          </dd>
          <dt className="dig-muted"><FormattedMessage id="dapp.approval.change" /></dt>
          <dd className="dig-mono" data-testid="approval-change" style={{ margin: 0, textAlign: 'right' }}>
            {xch(summary.changeMojos)} XCH<FiatEquivalent usd={xchMojosToUsd(summary.changeMojos, prices)} />
          </dd>
          <dt className="dig-muted"><FormattedMessage id="dapp.approval.fee" /></dt>
          <dd className="dig-mono" data-testid="approval-fee" style={{ margin: 0, textAlign: 'right' }}>
            {xch(summary.feeMojos)} XCH<FiatEquivalent usd={xchMojosToUsd(summary.feeMojos, prices)} />
          </dd>
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
        <div role="alert" data-testid="approval-cannot-sign">
          <p className="dig-error-text" style={{ margin: '0 0 4px' }}>
            <FormattedMessage id="dapp.approval.cannotSign" />
          </p>
          {/* #75 — surface the specific signer(s) the wallet cannot account for (foreign/over-broad). */}
          {summary.unaccountedSigners && summary.unaccountedSigners.length > 0 && (
            <ul data-testid="approval-unaccounted-signers" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {summary.unaccountedSigners.map((pk) => (
                <li key={pk} className="dig-mono dig-error-text" style={{ wordBreak: 'break-all', fontSize: '0.82em' }}>
                  {short(pk)}
                </li>
              ))}
            </ul>
          )}
        </div>
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

/** A trade leg (xch, a CAT, or an NFT — §94): resolved name/decimals + a fiat equivalent when the
 * asset is priced (#77). A CAT resolves its ticker from the SAME public registry `SendSummaryView`
 * uses; an NFT has no fungible amount to price, so it renders its launcher id only (unchanged). */
function LegRow({
  leg,
  prices,
  catRegistry,
}: {
  leg: { asset: DappOfferSummary['offered'][number]['asset']; amount: string };
  prices: PriceMap;
  catRegistry?: CatMetaMap;
}) {
  if (leg.asset.kind === 'xch') {
    return (
      <li className="dig-mono">
        {xch(leg.amount)} XCH<FiatEquivalent usd={xchMojosToUsd(leg.amount, prices)} />
      </li>
    );
  }
  if (leg.asset.kind === 'cat') {
    const meta = resolveCatMeta(leg.asset.assetId, catRegistry);
    return (
      <li className="dig-mono">
        {formatBaseUnits(leg.amount, meta.decimals)} {meta.ticker}
        <FiatEquivalent usd={catBaseUnitsToUsd(leg.asset.assetId, leg.amount, meta.decimals, prices)} />
      </li>
    );
  }
  return <li className="dig-mono">NFT {short(leg.asset.launcherId)}</li>;
}

/**
 * An expandable raw view of the exact decoded summary (#77) — a `<details>` disclosure so it never
 * clutters the default view; expanding it shows the SAME tamper-resistant facts rendered above, in
 * full, for a reviewer who wants every field (fees/signers/output hashes/…) beyond the human
 * summary. Rendered for every kind (send/spend/offer/message) from the ONE decoded `summary`.
 */
function RawDetails({ data }: { data: unknown }) {
  if (data == null) return null;
  return (
    <details data-testid="approval-raw-view" style={{ marginTop: 12 }}>
      <summary className="dig-muted" style={{ cursor: 'pointer' }}>
        <FormattedMessage id="dapp.approval.raw.title" />
      </summary>
      <pre
        className="dig-mono"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: 'rgba(0,0,0,0.04)', padding: 8, borderRadius: 8, marginTop: 8 }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

/** The decoded wallet-built send summary — recipient, amount, and fee, from the built spend. */
function SendSummaryView({
  summary,
  prices,
  catRegistry,
}: {
  summary: DappSendSummary | null;
  prices: PriceMap;
  catRegistry?: CatMetaMap;
}) {
  if (!summary) {
    return (
      <p className="dig-muted" data-testid="approval-no-summary">
        <FormattedMessage id="dapp.approval.decodeError" />
      </p>
    );
  }
  const isXch = !summary.asset || summary.asset.toLowerCase() === 'xch';
  // #77 — a CAT amount resolves its real name/ticker/decimals from the SAME public registry the
  // wallet's own balances view reads, instead of showing the raw truncated TAIL hex.
  const catMeta = isXch ? null : resolveCatMeta(summary.asset, catRegistry);
  const amountUsd = isXch ? xchMojosToUsd(summary.sent, prices) : catBaseUnitsToUsd(summary.asset, summary.sent, catMeta!.decimals, prices);
  return (
    <div data-testid="approval-send-summary">
      <h2 className="dig-section-title" id="approval-req-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="wallet.action.send" />
      </h2>
      <dl className="dig-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, margin: '8px 0' }}>
        <dt className="dig-muted"><FormattedMessage id="dapp.approval.to" /></dt>
        <dd className="dig-mono" data-testid="approval-send-to" style={{ margin: 0, textAlign: 'right', wordBreak: 'break-all' }}>{short(summary.recipientPuzzleHashHex)}</dd>
        <dt className="dig-muted"><FormattedMessage id="dapp.approval.amount" /></dt>
        <dd className="dig-mono" data-testid="approval-send-amount" style={{ margin: 0, textAlign: 'right' }}>
          {isXch ? `${xch(summary.sent)} XCH` : `${formatBaseUnits(summary.sent, catMeta!.decimals)} ${catMeta!.ticker}`}
          <FiatEquivalent usd={amountUsd} />
        </dd>
        <dt className="dig-muted"><FormattedMessage id="dapp.approval.fee" /></dt>
        <dd className="dig-mono" data-testid="approval-send-fee" style={{ margin: 0, textAlign: 'right' }}>
          {xch(summary.fee)} XCH<FiatEquivalent usd={xchMojosToUsd(summary.fee, prices)} />
        </dd>
      </dl>
    </div>
  );
}

/** The decoded two-sided trade summary — what the wallet gives vs receives, from the built offer. */
function OfferSummaryView({
  summary,
  prices,
  catRegistry,
}: {
  summary: DappOfferSummary | null;
  prices: PriceMap;
  catRegistry?: CatMetaMap;
}) {
  if (!summary) {
    return (
      <p className="dig-muted" data-testid="approval-no-summary">
        <FormattedMessage id="dapp.approval.decodeError" />
      </p>
    );
  }
  return (
    <div data-testid="approval-offer-summary">
      <h2 className="dig-section-title" id="approval-req-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="wallet.action.trade" />
      </h2>
      <p className="dig-muted" style={{ margin: '8px 0 4px' }}>
        <FormattedMessage id="dapp.approval.offer.give" />
      </p>
      <ul data-testid="approval-offer-give" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {summary.offered.map((leg, i) => (
          <LegRow key={`give-${i}`} leg={leg} prices={prices} catRegistry={catRegistry} />
        ))}
      </ul>
      <p className="dig-muted" style={{ margin: '12px 0 4px' }}>
        <FormattedMessage id="dapp.approval.offer.receive" />
      </p>
      <ul data-testid="approval-offer-receive" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {summary.requested.map((leg, i) => (
          <LegRow key={`receive-${i}`} leg={leg} prices={prices} catRegistry={catRegistry} />
        ))}
      </ul>
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
