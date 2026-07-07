import { useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { WalletIdenticon } from '@/features/wallet/custody/WalletIdenticon';
import {
  useSwitchWalletMutation,
  useRenameWalletMutation,
  useRemoveWalletMutation,
} from '@/features/wallet/custodyApi';
import { shortenAddress } from '@/lib/wallet-view';
import type { WalletMeta } from '@/lib/wallet-registry';

/** The `data-role` every row's primary switch button carries, for the roving keyboard nav below. */
const SWITCH_BTN_ROLE = 'wallet-switch-btn';

/**
 * The wallet-management list (#176) — every wallet, switch-able + rename-able + removable (kept
 * inline: with the popup's fixed 372px width this stays simple and uncomplicated per #176's design
 * note, so there is no separate fullscreen-only management surface to navigate to). Each row shows
 * a deterministic {@link WalletIdenticon} (keyed by the wallet's cached preview address when known,
 * else its opaque id — see `identicon.ts`; never key material) + its label + a truncated address
 * preview (`wallet.previewAddress`, populated opportunistically by the SW the first time this
 * wallet's own index-0 address is read while active — absent until then, so a never-yet-active
 * wallet shows a graceful placeholder instead of a fabricated address).
 *
 * Keyboard: ArrowUp/ArrowDown roves focus between the switch buttons (wrapping at the ends); Enter
 * activates the focused button natively (no extra wiring needed — that's how HTML buttons work);
 * Escape closes the whole sheet (handled by `Sheet`, above this in the tree).
 */
export function WalletManagerList({ wallets, onDone }: { wallets: WalletMeta[]; onDone: () => void }) {
  function handleListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(`[data-role="${SWITCH_BTN_ROLE}"]`),
    );
    if (buttons.length === 0) return;
    e.preventDefault();
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = idx === -1 ? (delta === 1 ? 0 : buttons.length - 1) : (idx + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <ul
      className="dig-switcher-list"
      data-testid="wallet-list"
      onKeyDown={handleListKeyDown}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {wallets.map((w) => (
        <li key={w.id}>
          <WalletRow wallet={w} canRemove={wallets.length > 1} onDone={onDone} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One wallet row: switch (active-aware), rename (inline), remove (two-step confirm, never the
 * last), and — when its key isn't cached this session — an inline unlock-and-switch prompt. Owns
 * only ephemeral UI state (the rename text, the unlock password, which affordance is open); the
 * registry mutations live in RTK Query so the tag cache reconciles every derived view.
 */
function WalletRow({ wallet, canRemove, onDone }: { wallet: WalletMeta; canRemove: boolean; onDone: () => void }) {
  const intl = useIntl();
  const [switchWallet, switchState] = useSwitchWalletMutation();
  const [renameWallet, renameState] = useRenameWalletMutation();
  const [removeWallet, removeState] = useRemoveWalletMutation();

  const [mode, setMode] = useState<'idle' | 'rename' | 'confirmRemove' | 'unlock'>('idle');
  const [name, setName] = useState(wallet.label);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const busy = switchState.isLoading || renameState.isLoading || removeState.isLoading;

  async function doSwitch() {
    setError(null);
    const res = await switchWallet({ walletId: wallet.id });
    if ('data' in res) {
      onDone();
      return;
    }
    // A wallet not unlocked this session needs its password → expand the inline unlock prompt.
    const code = (res.error as { code?: string } | undefined)?.code;
    if (code === 'NEEDS_UNLOCK') setMode('unlock');
    else setError(intl.formatMessage({ id: 'wallet.switcher.error.generic' }));
  }

  async function doUnlockSwitch() {
    setError(null);
    const res = await switchWallet({ walletId: wallet.id, password });
    if ('data' in res) {
      onDone();
      return;
    }
    setError(intl.formatMessage({ id: 'wallet.switcher.unlock.error' }));
  }

  async function doRename() {
    setError(null);
    const label = name.trim();
    if (!label) return;
    const res = await renameWallet({ walletId: wallet.id, label });
    if ('data' in res) setMode('idle');
    else setError(intl.formatMessage({ id: 'wallet.switcher.error.generic' }));
  }

  async function doRemove() {
    setError(null);
    const res = await removeWallet({ walletId: wallet.id });
    if ('data' in res) {
      onDone();
      return;
    }
    const code = (res.error as { code?: string } | undefined)?.code;
    setError(intl.formatMessage({ id: code === 'LAST_WALLET' ? 'wallet.switcher.error.lastWallet' : 'wallet.switcher.error.generic' }));
    setMode('idle');
  }

  const identiconSeed = wallet.previewAddress ?? wallet.id;

  return (
    <div className="dig-switcher-row" data-testid={`wallet-row-${wallet.id}`}>
      {mode === 'rename' ? (
        <form
          onSubmit={(e) => { e.preventDefault(); void doRename(); }}
          className="dig-switcher-row-form"
        >
          <input
            className="dig-input"
            data-testid={`wallet-rename-input-${wallet.id}`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label={intl.formatMessage({ id: 'wallet.switcher.rename.placeholder' })}
            autoFocus
          />
          <button type="submit" className="dig-btn dig-btn--primary" data-testid={`wallet-rename-save-${wallet.id}`} disabled={busy || !name.trim()}>
            <FormattedMessage id="wallet.switcher.rename.save" />
          </button>
          <button type="button" className="dig-btn" data-testid={`wallet-rename-cancel-${wallet.id}`} onClick={() => { setName(wallet.label); setMode('idle'); }}>
            <FormattedMessage id="wallet.switcher.cancel" />
          </button>
        </form>
      ) : (
        <div className="dig-switcher-row-main">
          <button
            type="button"
            data-role={SWITCH_BTN_ROLE}
            className="dig-switcher-select"
            data-testid={`wallet-switch-${wallet.id}`}
            onClick={() => void doSwitch()}
            disabled={busy}
            aria-current={wallet.active ? 'true' : undefined}
          >
            <WalletIdenticon seed={identiconSeed} size={26} />
            <span className="dig-switcher-row-text">
              <span className="dig-switcher-rowname">{wallet.label}</span>
              {wallet.previewAddress ? (
                <span className="dig-switcher-row-address dig-mono" data-testid={`wallet-address-preview-${wallet.id}`}>
                  {shortenAddress(wallet.previewAddress, 6, 4)}
                </span>
              ) : (
                <span
                  className="dig-switcher-row-address dig-muted"
                  data-testid={`wallet-address-preview-${wallet.id}`}
                  title={intl.formatMessage({ id: 'wallet.switcher.address.unknown' })}
                >
                  <span aria-hidden="true">—</span>
                  <span className="dig-sr-only">{intl.formatMessage({ id: 'wallet.switcher.address.unknown' })}</span>
                </span>
              )}
            </span>
            {wallet.active && (
              <span className="dig-badge" data-testid={`wallet-active-${wallet.id}`}>
                <FormattedMessage id="wallet.switcher.active.badge" />
              </span>
            )}
          </button>
          <button type="button" className="dig-iconbtn" data-testid={`wallet-rename-${wallet.id}`} aria-label={intl.formatMessage({ id: 'wallet.switcher.rename' })} title={intl.formatMessage({ id: 'wallet.switcher.rename' })} onClick={() => { setName(wallet.label); setMode('rename'); }}>
            ✎
          </button>
          {canRemove && (
            <button type="button" className="dig-iconbtn" data-testid={`wallet-remove-${wallet.id}`} aria-label={intl.formatMessage({ id: 'wallet.switcher.remove' })} title={intl.formatMessage({ id: 'wallet.switcher.remove' })} onClick={() => setMode('confirmRemove')}>
              🗑
            </button>
          )}
        </div>
      )}

      {mode === 'unlock' && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (password) void doUnlockSwitch(); }}
          data-testid={`wallet-unlock-${wallet.id}`}
          className="dig-switcher-row-expand"
        >
          <label className="dig-field">
            <span><FormattedMessage id="wallet.switcher.unlock.prompt" values={{ label: wallet.label }} /></span>
            <input
              className="dig-input"
              type="password"
              data-testid={`wallet-unlock-password-${wallet.id}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="dig-btn dig-btn--primary" data-testid={`wallet-unlock-submit-${wallet.id}`} disabled={busy || !password}>
              <FormattedMessage id={switchState.isLoading ? 'custody.unlock.working' : 'wallet.switcher.unlock.submit'} />
            </button>
            <button type="button" className="dig-btn" data-testid={`wallet-unlock-cancel-${wallet.id}`} onClick={() => { setPassword(''); setMode('idle'); }}>
              <FormattedMessage id="wallet.switcher.cancel" />
            </button>
          </div>
        </form>
      )}

      {mode === 'confirmRemove' && (
        <div data-testid={`wallet-remove-confirm-${wallet.id}`} className="dig-switcher-row-expand">
          <p className="dig-muted" role="alert" style={{ marginTop: 0 }}>
            <FormattedMessage id="wallet.switcher.remove.prompt" values={{ label: wallet.label }} />
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dig-btn dig-btn--danger" data-testid={`wallet-remove-yes-${wallet.id}`} onClick={() => void doRemove()} disabled={busy}>
              <FormattedMessage id="wallet.switcher.remove.confirm" />
            </button>
            <button type="button" className="dig-btn" data-testid={`wallet-remove-no-${wallet.id}`} onClick={() => setMode('idle')}>
              <FormattedMessage id="wallet.switcher.cancel" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="dig-error-text" role="alert" data-testid={`wallet-row-error-${wallet.id}`} style={{ marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
