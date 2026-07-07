import { useEffect, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import {
  MIN_UNLOCK_TTL_MINUTES,
  MAX_UNLOCK_TTL_MINUTES,
  resolveTtlMinutes,
} from '@/lib/custody-session';
import { readWalletSettings, updateWalletSettings } from '@/features/wallet/custody/settings';

/**
 * User-facing idle auto-lock timeout (#155): minutes of wallet inactivity before the SW locks the
 * vault (`isSessionRenewingAction` in `src/background/index.ts` slides the window forward on real
 * wallet activity, so this is a true IDLE timeout, not a fixed session length). Persisted to
 * `wallet.settings.unlockTtlMinutes` and read by the SW via the SAME `resolveTtlMinutes` clamp
 * used here, so the form and the enforcement point can never disagree on range or default.
 * Advanced-tier surface, alongside the chain-node override (the everyday user never needs it).
 */
export function AutoLockSetting() {
  const [minutes, setMinutes] = useState<number>(resolveTtlMinutes(null));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void readWalletSettings().then((s) => {
      if (live) setMinutes(resolveTtlMinutes(s));
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <form
      className="dig-card"
      data-testid="auto-lock-setting"
      // Native HTML5 constraint validation would silently BLOCK submit for an out-of-range value
      // (rangeOverflow/rangeUnderflow on the number input) instead of clamping it — the opposite of
      // this form's contract. Validation is delegated entirely to `resolveTtlMinutes` (the SAME
      // clamp the SW enforces), so any input — in or out of [min,max] — always saves a valid value.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const clamped = resolveTtlMinutes({ unlockTtlMinutes: minutes });
        void updateWalletSettings({ unlockTtlMinutes: clamped }).then(() => {
          setMinutes(clamped);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        });
      }}
    >
      <label className="dig-field">
        <span>
          <FormattedMessage id="custody.autolock.label" />
        </span>
        <input
          className="dig-input"
          data-testid="auto-lock-input"
          type="number"
          inputMode="numeric"
          min={MIN_UNLOCK_TTL_MINUTES}
          max={MAX_UNLOCK_TTL_MINUTES}
          step={1}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage
          id="custody.autolock.hint"
          values={{ min: MIN_UNLOCK_TTL_MINUTES, max: MAX_UNLOCK_TTL_MINUTES }}
        />
      </p>
      <button type="submit" className="dig-btn dig-btn--block" data-testid="auto-lock-save">
        <FormattedMessage id={saved ? 'custody.autolock.saved' : 'custody.autolock.save'} />
      </button>
    </form>
  );
}
