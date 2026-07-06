import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Sheet } from '@/components/Sheet';
import { FourState } from '@/components/FourState';
import { Onboarding } from '@/features/wallet/custody/Onboarding';
import {
  useListWalletsQuery,
  useSwitchWalletMutation,
  useRenameWalletMutation,
  useRemoveWalletMutation,
  useLockWalletMutation,
} from '@/features/wallet/custodyApi';
import type { WalletMeta } from '@/lib/wallet-registry';

/**
 * The active-wallet switcher (#90) — the shell control that holds SEVERAL wallets and switches the
 * active one. A compact pill (the active wallet's label) opens an accessible manager Sheet listing
 * every wallet; from it the user switches active, renames, removes (never the last, two-step
 * confirm), and adds a wallet (create fresh / import a phrase, reusing the onboarding flow). The
 * active wallet drives every derived view (balances / receive / send / activity) — switching
 * invalidates them all via the RTK Query tag cache, so the whole surface re-reads the new wallet.
 *
 * Switching to a wallet whose key isn't cached this session returns NEEDS_UNLOCK; the row then
 * expands into a password prompt (unlock-then-activate) — the decrypted key never leaves the vault.
 */
export function WalletSwitcher() {
  const intl = useIntl();
  const { data, isLoading, isError, refetch } = useListWalletsQuery();
  const [lockWallet, lockState] = useLockWalletMutation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'add'>('list');

  const wallets = data?.wallets ?? [];
  const active = wallets.find((w) => w.active) ?? wallets[0];
  const activeLabel = active?.label ?? intl.formatMessage({ id: 'wallet.switcher.fallback' });

  function close() {
    setOpen(false);
    setView('list');
  }

  return (
    <div className="dig-switcher" data-testid="wallet-switcher">
      <button
        type="button"
        className="dig-switcher-pill"
        data-testid="wallet-switcher-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={intl.formatMessage({ id: 'wallet.switcher.open' })}
      >
        <span className="dig-switcher-dot" aria-hidden="true" />
        <span className="dig-switcher-name" data-testid="wallet-switcher-active">{activeLabel}</span>
        <span className="dig-switcher-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <Sheet
          title={intl.formatMessage({ id: view === 'add' ? 'wallet.switcher.add.title' : 'wallet.switcher.title' })}
          onClose={close}
          testid="wallet-switcher-sheet"
        >
          {view === 'add' ? (
            <div data-testid="wallet-add-flow">
              <Onboarding onDone={close} />
              <button
                type="button"
                className="dig-btn dig-btn--block"
                data-testid="wallet-add-cancel"
                onClick={() => setView('list')}
              >
                <FormattedMessage id="wallet.switcher.add.cancel" />
              </button>
            </div>
          ) : (
            <FourState
              isLoading={isLoading && !data}
              isError={isError && !data}
              isEmpty={false}
              onRetry={() => void refetch()}
              testid="wallet-switcher-list"
            >
              <ul className="dig-switcher-list" data-testid="wallet-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {wallets.map((w) => (
                  <li key={w.id}>
                    <WalletRow wallet={w} canRemove={wallets.length > 1} onDone={close} />
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="dig-btn dig-btn--primary dig-btn--block"
                data-testid="wallet-add"
                style={{ marginTop: 12 }}
                onClick={() => setView('add')}
              >
                <FormattedMessage id="wallet.switcher.add" />
              </button>
              <button
                type="button"
                className="dig-btn dig-btn--block"
                data-testid="wallet-lock"
                style={{ marginTop: 8 }}
                disabled={lockState.isLoading}
                onClick={async () => {
                  await lockWallet();
                  close();
                }}
              >
                <FormattedMessage id="wallet.switcher.lock" />
              </button>
            </FourState>
          )}
        </Sheet>
      )}
    </div>
  );
}

/**
 * One wallet in the manager: switch (active-aware), rename (inline), remove (two-step confirm, never
 * the last), and — when its key isn't cached this session — an inline unlock-and-switch prompt. Owns
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

  return (
    <div className="dig-switcher-row" data-testid={`wallet-row-${wallet.id}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--dig-border, rgba(255,255,255,0.08))' }}>
      {mode === 'rename' ? (
        <form
          onSubmit={(e) => { e.preventDefault(); void doRename(); }}
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="dig-switcher-select"
            data-testid={`wallet-switch-${wallet.id}`}
            onClick={() => void doSwitch()}
            disabled={busy}
            aria-current={wallet.active ? 'true' : undefined}
            style={{ flex: 1, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit' }}
          >
            <span aria-hidden="true" style={{ width: 16 }}>{wallet.active ? '✓' : ''}</span>
            <span className="dig-switcher-rowname">{wallet.label}</span>
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
          style={{ marginTop: 8 }}
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
        <div data-testid={`wallet-remove-confirm-${wallet.id}`} style={{ marginTop: 8 }}>
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
