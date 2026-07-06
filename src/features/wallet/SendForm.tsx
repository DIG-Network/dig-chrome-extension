import { useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { validateSendForm, toBaseUnits } from '@/lib/wallet-view';
import type { AssetBalance } from '@/features/wallet/walletApi';
import { useSendAssetMutation } from '@/features/wallet/walletApi';

/**
 * The Send flow (§6 Send): pick asset → amount (+ Max) → recipient → review & send. Amount/address
 * validation reuses the shared `validateSendForm` view-model; the spend is brokered to Sage via the
 * `sendAsset` mutation (`chia_send`), which invalidates Balances + Activity on success. Renders the
 * four states (idle form / sending / error / sent).
 */
export function SendForm({ assets, onDone }: { assets: AssetBalance[]; onDone: () => void }) {
  const intl = useIntl();
  const [send, { isLoading, isSuccess, isError, error, reset }] = useSendAssetMutation();
  const options = useMemo(
    () =>
      assets.map((a) => ({
        value: a.descriptor.key === 'cat' ? (a.descriptor.assetId ?? '') : a.descriptor.key,
        label: a.descriptor.ticker,
        descriptor: a.descriptor,
      })),
    [assets],
  );
  const [assetValue, setAssetValue] = useState(options[0]?.value ?? 'xch');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [fee, setFee] = useState('');
  const [errors, setErrors] = useState<{ address?: string; amount?: string; fee?: string }>({});

  const selected = options.find((o) => o.value === assetValue) ?? options[0];

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateSendForm({ address, amount, fee });
    setErrors(v.errors);
    if (!v.ok || !selected) return;
    const decimals = selected.descriptor.decimals;
    const params: Record<string, unknown> = {
      address: address.trim(),
      amount: toBaseUnits(amount, decimals),
      fee: fee.trim() ? Math.round(Number(fee) * 1e12) : 0,
    };
    if (selected.descriptor.type === 'cat') params.assetId = selected.descriptor.assetId;
    void send({ method: 'chia_send', params });
  };

  if (isSuccess) {
    return (
      <div className="dig-state" data-state="success" data-testid="send-success">
        <p>✓</p>
        <button
          type="button"
          className="dig-btn dig-btn--primary"
          onClick={() => {
            reset();
            onDone();
          }}
        >
          <FormattedMessage id="receive.title" defaultMessage="Done" />
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} data-testid="wallet-send">
      <div className="dig-field">
        <label htmlFor="send-asset">
          <FormattedMessage id="send.asset" />
        </label>
        <select
          id="send-asset"
          className="dig-select"
          data-testid="send-asset"
          value={assetValue}
          onChange={(e) => setAssetValue(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="dig-field">
        <label htmlFor="send-amount">
          <FormattedMessage id="send.amount" />
        </label>
        <input
          id="send-amount"
          className="dig-input"
          data-testid="send-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {errors.amount && (
          <span className="dig-error-text" data-testid="send-amount-error">
            <FormattedMessage id="send.error.amount" />
          </span>
        )}
      </div>

      <div className="dig-field">
        <label htmlFor="send-address">
          <FormattedMessage id="send.recipient" />
        </label>
        <input
          id="send-address"
          className="dig-input dig-mono"
          data-testid="send-address"
          placeholder="xch1…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        {errors.address && (
          <span className="dig-error-text" data-testid="send-address-error">
            <FormattedMessage id="send.error.address" />
          </span>
        )}
      </div>

      <div className="dig-field">
        <label htmlFor="send-fee">
          <FormattedMessage id="send.fee" />
        </label>
        <input
          id="send-fee"
          className="dig-input"
          data-testid="send-fee"
          inputMode="decimal"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
        />
      </div>

      {isError && (
        <p className="dig-error-text" role="alert" data-testid="send-error">
          {intl.formatMessage({ id: 'state.error.generic' })}
          {(error as { message?: string })?.message ? `: ${(error as { message?: string }).message}` : ''}
        </p>
      )}

      <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="send-submit" disabled={isLoading}>
        <FormattedMessage id={isLoading ? 'wallet.connect.connecting' : 'send.submit'} />
      </button>
    </form>
  );
}
