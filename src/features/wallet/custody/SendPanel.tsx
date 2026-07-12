import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { toBaseUnits, formatBaseUnits, validateSendForm, shortenAddress, isChiaAddress } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/assetTypes';
import { useConfirmSendMutation, useLazySendStatusQuery, useGetCoinsQuery, type PreparedSend } from '@/features/wallet/custodyApi';
import { useConsolidatingSend } from '@/features/wallet/custody/useConsolidatingSend';
import { ConsolidateModal } from '@/features/wallet/custody/ConsolidateModal';
import { ContactPicker } from '@/features/contacts/ContactPicker';
import { FeeField } from '@/features/wallet/custody/FeeField';
import { useContacts } from '@/features/contacts/useContacts';
import { assessRecipient } from '@/features/contacts/address-poisoning';
import { ViewHeader } from '@/components/ViewHeader';
import { isFullpageSurface } from '@/features/collectibles/surface';
import { QrScanner } from '@/features/wallet/custody/QrScanner';

const XCH_DECIMALS = 12;

/** Clawback (#152) preset windows — a fullscreen-only ADVANCED send option (§145): a duration the
 * UI turns into an absolute unix timestamp at submit time (`now + seconds`), never a raw value the
 * user types (the on-chain puzzle only understands an absolute deadline). */
const CLAWBACK_PRESETS = [
  { value: '1h', seconds: 3600, labelId: 'send.clawback.window.1h' },
  { value: '1d', seconds: 86400, labelId: 'send.clawback.window.1d' },
  { value: '3d', seconds: 3 * 86400, labelId: 'send.clawback.window.3d' },
  { value: '7d', seconds: 7 * 86400, labelId: 'send.clawback.window.7d' },
] as const;

type Phase = 'form' | 'review' | 'sending' | 'confirmed' | 'failed';

/** Map a consolidating-prepare failure code (#417) to a localized send-form message id. */
const SEND_ERROR_ID: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'send.error.insufficient',
  NEEDS_CONSOLIDATION: 'send.error.needsConsolidation',
  CONSOLIDATION_TIMEOUT: 'send.error.consolidationTimeout',
};

/**
 * Self-custody Send (§6) for XCH + CATs. A state machine: form (asset picker + recipient + amount +
 * Max + fee) → review (the decoded, tamper-resistant summary from the built spend) → confirm (sign +
 * BROADCAST — the only real spend) → optimistic "Sending…" → poll → Confirmed / Not-confirmed-retry.
 * Amounts use the selected asset's decimals; the fee is always XCH. `pollMs` is injectable for tests.
 */
export function SendPanel({
  assets,
  onClose,
  onManageContacts,
  pollMs = 8000,
  full,
}: {
  assets: AssetBalance[];
  onClose?: () => void;
  /** Open the full address-book manager (from the recipient picker's "Manage" link). */
  onManageContacts?: () => void;
  pollMs?: number;
  /** Fullscreen surface override for tests; auto-detected from the URL otherwise (#145/#152 — the
   * clawback advanced option is fullscreen-only, mirroring `CustodyWallet`'s own `full` prop). */
  full?: boolean;
}) {
  const intl = useIntl();
  const isFull = full ?? isFullpageSurface();
  const [phase, setPhase] = useState<Phase>('form');
  const [assetIdx, setAssetIdx] = useState(0);
  const [recipient, setRecipient] = useState('');
  // #74: the user must acknowledge a confusable-lookalike warning before an address-poisoning
  // recipient can be sent to. Reset whenever the recipient changes so a new address re-requires it.
  const [poisonAck, setPoisonAck] = useState(false);
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('0');
  // #105 — an optional plain-text memo attached to the send. Memos are PUBLIC on chain (send.memo.hint).
  const [memo, setMemo] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSend | null>(null);
  const [spentCoinId, setSpentCoinId] = useState<string | null>(null);
  // Coin control (#91): optional hand-picked funding coins (empty set = automatic selection).
  const [pickCoins, setPickCoins] = useState(false);
  const [selectedCoins, setSelectedCoins] = useState<Set<string>>(new Set());
  // Clawback (#152): fullscreen-only ADVANCED send option — send WITH a reclaimable timelock.
  const [clawback, setClawback] = useState(false);
  const [clawbackWindow, setClawbackWindow] = useState<(typeof CLAWBACK_PRESETS)[number]['value']>('1d');
  // QR camera scanner (#107): fullscreen-only (a live camera preview needs more room than the
  // compact popup, and the OS permission prompt can steal focus and close a popup).
  const [scanning, setScanning] = useState(false);

  // #417 — the consolidating send wrapper: on NEEDS_CONSOLIDATION it combines the wallet's small
  // coins (honest modal) and retries, so a fragmented wallet can still send. Owns the modal state.
  const consolidating = useConsolidatingSend({ pollMs });
  const [confirmSend, conf] = useConfirmSendMutation();
  const [pollStatus] = useLazySendStatusQuery();

  const { contacts, recents, labelForAddress, recordRecent, add: addContact } = useContacts();
  const recipientLabel = labelForAddress(recipient);

  // #74 — classify the recipient against saved contacts + recent recipients: a confusable lookalike
  // (same start+end as a known address, different middle) is the address-poisoning signature.
  const assessment = useMemo(() => assessRecipient(recipient, contacts, recents), [recipient, contacts, recents]);
  const topLookalike = assessment.lookalikes[0] ?? null;
  const lookalikeName = topLookalike ? (topLookalike.label ?? shortenAddress(topLookalike.address)) : '';
  // A lookalike recipient blocks the build until the user explicitly acknowledges the warning.
  const poisonBlocked = assessment.kind === 'lookalike' && !poisonAck;

  // Update the recipient and reset the poison acknowledgement so a new address re-requires it.
  function updateRecipient(value: string) {
    setRecipient(value);
    setPoisonAck(false);
  }

  const selected = assets[assetIdx] ?? assets[0];
  const decimals = selected?.descriptor.decimals ?? XCH_DECIMALS;
  const ticker = selected?.descriptor.ticker ?? 'XCH';
  const assetId = selected?.descriptor.assetId ?? null; // null → native XCH
  const isXch = !assetId;
  const spendable = selected?.balance ?? 0;
  const feeMojos = safeBaseUnits(fee, XCH_DECIMALS);

  // Coin control (#91): only fetch the coin list when the picker is open, for the selected asset.
  const coinsQuery = useGetCoinsQuery({ ...(assetId ? { assetId } : {}) }, { skip: !pickCoins });
  const pickerCoins = coinsQuery.data?.coins ?? [];

  function toggleCoin(coinId: string) {
    setSelectedCoins((prev) => {
      const next = new Set(prev);
      if (next.has(coinId)) next.delete(coinId);
      else next.add(coinId);
      return next;
    });
  }

  function setMax() {
    // XCH: leave room for the fee. CAT: the fee is paid in XCH, so Max is the full token balance.
    const max = isXch ? Math.max(0, spendable - feeMojos) : spendable;
    setAmount(formatBaseUnits(max, decimals));
  }

  async function doPrepare() {
    // #74 — never build a spend to a confusable lookalike until the warning is acknowledged (guards
    // an Enter-key submit that bypasses the disabled button).
    if (poisonBlocked) return;
    const v = validateSendForm({ address: recipient, amount, fee });
    if (!v.ok) {
      setLocalError(v.errors.address || v.errors.amount || v.errors.fee || intl.formatMessage({ id: 'send.error.amount' }));
      return;
    }
    const amountBase = safeBaseUnits(amount, decimals);
    const overspend = isXch ? amountBase + feeMojos > spendable : amountBase > spendable;
    if (overspend) {
      setLocalError(intl.formatMessage({ id: 'send.error.insufficient' }));
      return;
    }
    setLocalError(null);
    const coinIds = pickCoins && selectedCoins.size > 0 ? [...selectedCoins] : undefined;
    // Clawback (#152): XCH only (v1) — computed as an ABSOLUTE unix timestamp at submit time, never
    // a raw duration (the on-chain puzzle only understands a deadline, not "N seconds from now").
    const clawbackSeconds =
      isFull && isXch && clawback
        ? String(Math.floor(Date.now() / 1000) + (CLAWBACK_PRESETS.find((p) => p.value === clawbackWindow)?.seconds ?? 86400))
        : undefined;
    // The consolidating wrapper transparently combines small coins + retries on NEEDS_CONSOLIDATION
    // (driving its own modal); it resolves to the prepared send or a stable failure code.
    const res = await consolidating.prepare({
      recipient,
      amount: String(amountBase),
      fee: String(feeMojos),
      ...(assetId ? { assetId } : {}),
      ...(coinIds ? { coinIds } : {}),
      ...(clawbackSeconds ? { clawbackSeconds } : {}),
      ...(memo.trim() ? { memo: memo.trim() } : {}),
    });
    if (res.ok) {
      setPrepared(res.prepared);
      setPhase('review');
    } else {
      setLocalError(intl.formatMessage({ id: SEND_ERROR_ID[res.code] ?? 'send.error.build' }));
    }
  }

  async function doConfirm() {
    if (!prepared) return;
    setPhase('sending');
    const res = await confirmSend({ pendingId: prepared.pendingId });
    if ('data' in res && res.data?.spentCoinId) {
      setSpentCoinId(res.data.spentCoinId);
      recordRecent(recipient); // remember this recipient for the picker's "Recent" list
    } else {
      setPhase('failed');
    }
  }

  // Poll to a terminal state once broadcast (an input coin recorded spent = confirmed).
  useEffect(() => {
    if (phase !== 'sending' || !spentCoinId) return;
    let live = true;
    const timer = setInterval(async () => {
      const res = await pollStatus({ coinId: spentCoinId });
      if (live && 'data' in res && res.data?.confirmed) {
        setPhase('confirmed');
        clearInterval(timer);
      }
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [phase, spentCoinId, pollMs, pollStatus]);

  const busy = consolidating.running || conf.isLoading;

  // #166 — the header's back action always steps UP one level: mid-review it returns to the form
  // (same as the old `send-back` link); otherwise it closes the whole Send screen. No back is shown
  // while a spend is actively broadcasting ('sending') — the (former) bottom-of-form placement
  // is gone; both live in the sticky `ViewHeader` now, reachable regardless of how tall the form/
  // coin-picker/review content grows.
  const headerBack = phase === 'sending' ? undefined : phase === 'review' ? () => setPhase('form') : onClose;
  const headerBackLabel = phase === 'review' ? <FormattedMessage id="send.back" /> : <FormattedMessage id="send.cancel" />;
  const headerBackTestId = phase === 'review' ? 'send-back' : 'send-cancel';

  return (
    <div data-testid="custody-send">
      {/* #417 — the auto-consolidate modal (honest, dismissible) driven by the consolidating send. */}
      <ConsolidateModal
        state={consolidating.modal}
        onConfirm={() => consolidating.resolvePrompt(true)}
        onCancel={() => consolidating.resolvePrompt(false)}
      />
      <ViewHeader
        onBack={headerBack}
        backLabel={headerBackLabel}
        backTestId={headerBackTestId}
        title={<FormattedMessage id="send.title" />}
        titleId="send-title"
      />
      <section className="dig-card" aria-labelledby="send-title">
      {phase === 'form' && scanning && (
        <QrScanner
          onScan={(text) => {
            updateRecipient(text);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {phase === 'form' && !scanning && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doPrepare();
          }}
        >
          <label className="dig-field">
            <span><FormattedMessage id="send.asset" /></span>
            <select
              data-testid="send-asset"
              className="dig-input"
              value={assetIdx}
              onChange={(e) => {
                setAssetIdx(Number(e.target.value));
                setAmount('');
                setSelectedCoins(new Set()); // coin selection is per-asset (#91)
              }}
            >
              {assets.map((a, i) => (
                <option key={a.descriptor.key + (a.descriptor.assetId ?? '')} value={i}>
                  {a.descriptor.ticker} — {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="dig-field">
            <span><FormattedMessage id="send.recipient" /></span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input data-testid="send-recipient" className="dig-input dig-mono" value={recipient} onChange={(e) => updateRecipient(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xch1…" style={{ flex: 1 }} />
              {/* #107 — QR camera scanner: fullscreen-only (a live camera preview needs more room
                  than the compact popup, and the OS permission prompt can steal focus and close a
                  popup). */}
              {isFull && (
                <button type="button" className="dig-btn" data-testid="send-scan-qr" onClick={() => setScanning(true)}>
                  <FormattedMessage id="send.scan.button" />
                </button>
              )}
            </div>
          </label>
          <ContactPicker onPick={updateRecipient} onManage={onManageContacts} />
          {recipientLabel && (
            <p className="dig-muted" data-testid="send-recipient-contact" style={{ margin: '2px 0 8px' }}>
              <FormattedMessage id="send.recipient.sendingTo" values={{ label: <strong>{recipientLabel}</strong> }} />
            </p>
          )}
          {/* #74 — address-poisoning defense: a confusable lookalike of a known recipient raises a
              blocking warning the user must acknowledge; a valid never-seen address gets a subtle
              first-time notice. An exact contact ('known') / prior recipient ('seen') shows neither. */}
          {assessment.kind === 'lookalike' && (
            <div className="dig-state" data-state="error" role="alert" data-testid="send-poison-warning" style={{ margin: '4px 0 10px' }}>
              <p style={{ margin: '0 0 6px', fontWeight: 600 }}>
                <FormattedMessage id="send.poison.title" />
              </p>
              <p style={{ margin: '0 0 8px' }}>
                <FormattedMessage id="send.poison.body" values={{ label: <strong>{lookalikeName}</strong> }} />
              </p>
              <label className="dig-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, margin: 0 }}>
                <input type="checkbox" className="dig-check" data-testid="send-poison-ack" checked={poisonAck} onChange={(e) => setPoisonAck(e.target.checked)} />
                <span><FormattedMessage id="send.poison.ack" /></span>
              </label>
            </div>
          )}
          {assessment.kind === 'firstTime' && (
            <p className="dig-muted" data-testid="send-firsttime" style={{ margin: '2px 0 8px' }}>
              <FormattedMessage id="send.firstTime" />
            </p>
          )}
          <label className="dig-field">
            <span><FormattedMessage id="send.amount" /> ({ticker})</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input data-testid="send-amount" className="dig-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <button type="button" className="dig-btn" data-testid="send-max" onClick={setMax}>
                <FormattedMessage id="send.max" />
              </button>
            </div>
          </label>
          {/* #206/#110 — network fee: defaults to the live coinset.org estimate as a read-only line
              item with fast/normal/slow presets + an "Override" button (bias-to-estimate). */}
          <FeeField fee={fee} onFee={setFee} />

          {/* #105 — an optional plain-text memo/note attached to the send. Memos are PUBLIC on
              chain, so the hint below the field says so explicitly — never sensitive info. */}
          <label className="dig-field">
            <span><FormattedMessage id="send.memo.label" /></span>
            <input
              data-testid="send-memo"
              className="dig-input"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          </label>
          <p className="dig-muted" style={{ margin: '-6px 0 8px', fontSize: '0.85em' }}>
            <FormattedMessage id="send.memo.hint" />
          </p>

          {/* Coin control (#91): optionally hand-pick which coins fund the send. */}
          <div style={{ margin: '4px 0 12px' }}>
            <button
              type="button"
              className="dig-link"
              data-testid="send-choose-coins"
              aria-expanded={pickCoins}
              onClick={() => setPickCoins((v) => !v)}
            >
              <FormattedMessage id="send.coins.choose" />
              {pickCoins && selectedCoins.size > 0 && (
                <span className="dig-muted"> · <FormattedMessage id="send.coins.selected" values={{ count: selectedCoins.size }} /></span>
              )}
            </button>
            {pickCoins && (
              <div data-testid="send-coin-picker" style={{ marginTop: 6 }}>
                <p className="dig-muted" style={{ margin: '0 0 6px' }}>
                  <FormattedMessage id={selectedCoins.size === 0 ? 'send.coins.auto' : 'send.coins.selected'} values={{ count: selectedCoins.size }} />
                </p>
                {coinsQuery.isLoading ? (
                  <p className="dig-muted" role="status"><FormattedMessage id="send.coins.loading" /></p>
                ) : pickerCoins.length === 0 ? (
                  <p className="dig-muted"><FormattedMessage id="send.coins.none" /></p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
                    {pickerCoins.map((c) => (
                      <li key={c.coinId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                        <input
                          type="checkbox"
                          className="dig-check"
                          data-testid={`send-coin-${c.coinId}`}
                          checked={selectedCoins.has(c.coinId)}
                          onChange={() => toggleCoin(c.coinId)}
                          aria-label={`${formatBaseUnits(Number(c.amount), decimals)} ${ticker} — ${shortenAddress(c.coinId)}`}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {formatBaseUnits(Number(c.amount), decimals)} {ticker}{' '}
                          <span className="dig-mono dig-muted" style={{ fontSize: '0.78em' }}>{shortenAddress(c.coinId)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Clawback (#152) — an ADVANCED send option, fullscreen-only (§145): the basic popup send
              never shows this. XCH only (v1); a CAT selection hides it entirely. */}
          {isFull && isXch && (
            <div style={{ margin: '4px 0 12px' }}>
              <label className="dig-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  className="dig-check"
                  data-testid="send-clawback-toggle"
                  checked={clawback}
                  onChange={(e) => setClawback(e.target.checked)}
                />
                <span><FormattedMessage id="send.clawback.enable" /></span>
              </label>
              {clawback && (
                <div data-testid="send-clawback-options" style={{ marginTop: 6 }}>
                  <p className="dig-muted" style={{ margin: '0 0 6px' }}>
                    <FormattedMessage id="send.clawback.hint" />
                  </p>
                  <label className="dig-field">
                    <span><FormattedMessage id="send.clawback.window" /></span>
                    <select
                      data-testid="send-clawback-window"
                      className="dig-input"
                      value={clawbackWindow}
                      onChange={(e) => setClawbackWindow(e.target.value as (typeof CLAWBACK_PRESETS)[number]['value'])}
                    >
                      {CLAWBACK_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {intl.formatMessage({ id: p.labelId })}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}

          {localError && <p className="dig-error-text" role="alert" data-testid="send-error">{localError}</p>}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="send-review" disabled={busy || poisonBlocked}>
            <FormattedMessage id={busy ? 'custody.working' : 'send.submit'} />
          </button>
        </form>
      )}

      {phase === 'review' && prepared && (
        <div data-testid="send-review-panel">
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="send.review.intro" />
          </p>
          <dl className="dig-summary">
            <dt><FormattedMessage id="send.review.amount" /></dt>
            <dd data-testid="review-sent">{formatBaseUnits(Number(prepared.summary.sent), decimals)} {ticker}</dd>
            <dt><FormattedMessage id="send.review.fee" /></dt>
            <dd data-testid="review-fee">{formatBaseUnits(Number(prepared.summary.fee), XCH_DECIMALS)} XCH</dd>
            <dt><FormattedMessage id="send.review.recipient" /></dt>
            <dd data-testid="review-recipient">
              {recipientLabel ? (
                <>
                  <strong data-testid="review-recipient-label">{recipientLabel}</strong>
                  <span className="dig-mono dig-muted" style={{ display: 'block', fontSize: '0.8em' }}>{shortenAddress(recipient)}</span>
                </>
              ) : (
                <span className="dig-mono">{recipient}</span>
              )}
            </dd>
            {prepared.summary.memoText && (
              <>
                <dt><FormattedMessage id="send.review.memo" /></dt>
                <dd data-testid="review-memo">{prepared.summary.memoText}</dd>
              </>
            )}
          </dl>
          {prepared.clawbackInfo && (
            <p className="dig-muted" data-testid="review-clawback" style={{ margin: '0 0 8px' }}>
              <FormattedMessage
                id="send.clawback.review"
                values={{ when: intl.formatDate(Number(prepared.clawbackInfo.seconds) * 1000, { dateStyle: 'medium', timeStyle: 'short' }) }}
              />
            </p>
          )}
          {isChiaAddress(recipient) && (
            <SaveRecipientInline alreadySaved={!!recipientLabel} onSave={(label) => addContact({ label, address: recipient })} />
          )}
          <button type="button" className="dig-btn dig-btn--primary dig-btn--block" data-testid="send-confirm" onClick={() => void doConfirm()} disabled={busy}>
            <FormattedMessage id="send.confirm" />
          </button>
        </div>
      )}

      {phase === 'sending' && (
        <div className="dig-state" data-state="loading" role="status" data-testid="send-sending">
          <FormattedMessage id="send.sending" />
        </div>
      )}
      {phase === 'confirmed' && (
        <div className="dig-state" data-state="success" role="status" data-testid="send-confirmed">
          <p><FormattedMessage id="send.confirmed" /></p>
          {onClose && (
            <button type="button" className="dig-btn dig-btn--block" data-testid="send-done" onClick={onClose}>
              <FormattedMessage id="send.done" />
            </button>
          )}
        </div>
      )}
      {phase === 'failed' && (
        <div className="dig-state" data-state="error" role="alert" data-testid="send-failed">
          <p><FormattedMessage id="send.failed" /></p>
          <button type="button" className="dig-btn dig-btn--block" data-testid="send-retry" onClick={() => setPhase('form')}>
            <FormattedMessage id="state.retry" />
          </button>
        </div>
      )}
      </section>
    </div>
  );
}

/**
 * Add-on-send (#88): inline "save this recipient" shown in the review step. Renders nothing when the
 * recipient is already a saved contact (unless WE just saved it — then a brief confirmation stays).
 * `onSave` is the parent's single-instance address-book add, so the review's label preference flips
 * to the saved name in the same tick — deterministic, no cross-instance storage round-trip.
 */
function SaveRecipientInline({ alreadySaved, onSave }: { alreadySaved: boolean; onSave: (label: string) => { ok: boolean; errors?: { label?: string; address?: string } } }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (saved) {
    return (
      <p className="dig-state" data-state="success" role="status" data-testid="save-contact-saved" style={{ margin: '8px 0' }}>
        <FormattedMessage id="send.saveContact.saved" />
      </p>
    );
  }
  if (alreadySaved) return null; // recipient is a known contact — nothing to offer

  if (!open) {
    return (
      <button type="button" className="dig-link" data-testid="save-contact-open" onClick={() => setOpen(true)} style={{ margin: '6px 0' }}>
        <FormattedMessage id="send.saveContact.prompt" />
      </button>
    );
  }

  function save() {
    const res = onSave(label);
    if (res.ok) {
      setSaved(true);
      setError(null);
    } else {
      setError(res.errors?.label ?? res.errors?.address ?? 'contacts.error.label');
    }
  }

  return (
    <div data-testid="save-contact-form" style={{ margin: '8px 0' }}>
      <label className="dig-field">
        <span><FormattedMessage id="send.saveContact.label" /></span>
        <input className="dig-input" data-testid="save-contact-label" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" maxLength={80} placeholder={intl.formatMessage({ id: 'contacts.field.label' })} />
      </label>
      {error && <p className="dig-error-text" role="alert" data-testid="save-contact-error"><FormattedMessage id={error} /></p>}
      <button type="button" className="dig-btn" data-testid="save-contact-save" onClick={save}>
        <FormattedMessage id="send.saveContact.save" />
      </button>
    </div>
  );
}

/** Parse a decimal amount to base units for the given decimals; 0 on garbage (validation catches it). */
function safeBaseUnits(value: string, decimals: number): number {
  try {
    const n = toBaseUnits(value || '0', decimals);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
