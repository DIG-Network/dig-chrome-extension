import { useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { buildOfferParams, validateOfferString } from '#shared/wallet-offers.mjs';
import type { AssetBalance } from '@/features/wallet/walletApi';
import { useOfferActionMutation } from '@/features/wallet/walletApi';

/** Map an asset descriptor to a Send/offer picker value (xch | dig | a CAT's TAIL). */
function pickerValue(a: AssetBalance): string {
  return a.descriptor.key === 'cat' ? (a.descriptor.assetId ?? '') : a.descriptor.key;
}

/**
 * The Trade view (§6 Trade — the offers hero): MAKE a trade (you give / you get → build a
 * shareable offer) and TAKE a trade (paste `offer1…` → review & accept). Offer math + validation
 * reuse the shared `wallet-offers` view-model; the offer is brokered to Sage via the `offerAction`
 * mutation. Four states throughout.
 */
export function Trade({ assets }: { assets: AssetBalance[] }) {
  const intl = useIntl();
  const [makeOffer, makeState] = useOfferActionMutation();
  const [takeOffer, takeState] = useOfferActionMutation();

  const options = useMemo(
    () => assets.map((a) => ({ value: pickerValue(a), label: a.descriptor.ticker })),
    [assets],
  );
  const watchedCats = useMemo(
    () =>
      assets
        .filter((a) => a.descriptor.key === 'cat')
        .map((a) => ({ assetId: a.descriptor.assetId ?? '', name: a.descriptor.name })),
    [assets],
  );

  const [giveValue, setGiveValue] = useState(options[0]?.value ?? 'xch');
  const [giveAmount, setGiveAmount] = useState('');
  const [getValue, setGetValue] = useState(options[1]?.value ?? 'dig');
  const [getAmount, setGetAmount] = useState('');
  const [makeErr, setMakeErr] = useState('');

  const [offerString, setOfferString] = useState('');
  const [takeErr, setTakeErr] = useState('');

  const onMake = (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildOfferParams({ giveValue, giveAmount, getValue, getAmount, watchedCats });
    if (!built.ok || !built.params) {
      setMakeErr(built.error ?? intl.formatMessage({ id: 'send.error.amount' }));
      return;
    }
    setMakeErr('');
    void makeOffer({ method: 'chia_createOffer', params: built.params as unknown as Record<string, unknown> });
  };

  const onTake = (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateOfferString(offerString);
    if (!v.ok) {
      setTakeErr(v.error ?? intl.formatMessage({ id: 'trade.error.invalid' }));
      return;
    }
    setTakeErr('');
    void takeOffer({ method: 'chia_takeOffer', params: { offer: offerString.trim() } });
  };

  return (
    <div data-testid="wallet-trade">
      <p className="dig-muted">
        <FormattedMessage id="trade.intro" />
      </p>

      <section className="dig-card" aria-labelledby="trade-make-title">
        <h3 className="dig-section-title" id="trade-make-title">
          <FormattedMessage id="trade.make" />
        </h3>
        <form onSubmit={onMake}>
          <div className="dig-field">
            <label htmlFor="offer-give-asset">
              <FormattedMessage id="trade.give" />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                id="offer-give-asset"
                className="dig-select"
                data-testid="offer-give-asset"
                value={giveValue}
                onChange={(e) => setGiveValue(e.target.value)}
              >
                {options.map((o) => (
                  <option key={`give-${o.value}`} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="dig-input"
                data-testid="offer-give-amount"
                inputMode="decimal"
                aria-label={intl.formatMessage({ id: 'send.amount' })}
                value={giveAmount}
                onChange={(e) => setGiveAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="dig-field">
            <label htmlFor="offer-get-asset">
              <FormattedMessage id="trade.get" />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                id="offer-get-asset"
                className="dig-select"
                data-testid="offer-get-asset"
                value={getValue}
                onChange={(e) => setGetValue(e.target.value)}
              >
                {options.map((o) => (
                  <option key={`get-${o.value}`} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="dig-input"
                data-testid="offer-get-amount"
                inputMode="decimal"
                aria-label={intl.formatMessage({ id: 'send.amount' })}
                value={getAmount}
                onChange={(e) => setGetAmount(e.target.value)}
              />
            </div>
          </div>
          {makeErr && (
            <p className="dig-error-text" role="alert" data-testid="offer-make-error">
              {makeErr}
            </p>
          )}
          <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="offer-make-submit" disabled={makeState.isLoading}>
            <FormattedMessage id="trade.make" />
          </button>
        </form>
      </section>

      <section className="dig-card" aria-labelledby="trade-take-title">
        <h3 className="dig-section-title" id="trade-take-title">
          <FormattedMessage id="trade.take.accept" />
        </h3>
        <form onSubmit={onTake}>
          <div className="dig-field">
            <label htmlFor="offer-take-string">
              <FormattedMessage id="trade.take.label" />
            </label>
            <input
              id="offer-take-string"
              className="dig-input dig-mono"
              data-testid="offer-take-string"
              placeholder="offer1…"
              value={offerString}
              onChange={(e) => setOfferString(e.target.value)}
            />
          </div>
          {takeErr && (
            <p className="dig-error-text" role="alert" data-testid="offer-take-error">
              {takeErr}
            </p>
          )}
          <button type="submit" className="dig-btn dig-btn--block" data-testid="offer-take-submit" disabled={takeState.isLoading}>
            <FormattedMessage id="trade.take.accept" />
          </button>
        </form>
      </section>
    </div>
  );
}
