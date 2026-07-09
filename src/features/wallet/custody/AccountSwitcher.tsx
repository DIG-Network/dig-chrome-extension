import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Sheet } from '@/components/Sheet';
import { FourState } from '@/components/FourState';
import {
  useListWalletsQuery,
  useSetActiveIndexMutation,
  useAddAccountMutation,
  useRenameAccountMutation,
  useRemoveAccountMutation,
} from '@/features/wallet/custodyApi';
import type { AccountEntry } from '@/lib/wallet-registry';

/**
 * The named-account switcher (#95) — a friendly LABEL over one HD derivation index within the ACTIVE
 * wallet (§18.18). It does NOT introduce a second derivation dimension or a multi-index scan (#165
 * stays the single-active-index model): switching to an account simply sets the wallet's active
 * index to that account's index (`setActiveIndex`), reusing the exact same op the index navigator
 * uses. A compact pill (the active account's label) opens an accessible manager Sheet: switch / add /
 * rename / remove, mirroring the wallet switcher's own affordances.
 *
 * Placed beside {@link WalletSwitcher} + {@link IndexNavigator} in the wallet shell — all three are
 * "which identity/slot am I viewing" controls (wallet ⊃ account ⊃ raw index). Non-destructive (no
 * funds at risk — an account is only a label), so it stays in the popup rather than fullscreen-gated.
 */
export function AccountSwitcher() {
  const intl = useIntl();
  const { data, isLoading, isError, refetch } = useListWalletsQuery();
  const [open, setOpen] = useState(false);

  const wallets = data?.wallets ?? [];
  const active = wallets.find((w) => w.active) ?? wallets[0];
  const accounts = active?.accounts ?? [];
  const activeAccount = accounts.find((a) => a.index === (active?.activeIndex ?? 0));
  const activeLabel = activeAccount?.label ?? intl.formatMessage({ id: 'account.switcher.label' });

  // With no wallet (or exactly one default account and nothing to manage) the switcher still renders,
  // so a user can always add a second account; but hide it entirely while there is no wallet at all.
  if (!active) return null;

  return (
    <div className="dig-switcher" data-testid="account-switcher">
      <button
        type="button"
        className="dig-switcher-pill"
        data-testid="account-switcher-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={intl.formatMessage({ id: 'account.switcher.open' })}
      >
        <span className="dig-switcher-name" data-testid="account-switcher-active">{activeLabel}</span>
        <span className="dig-switcher-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <Sheet
          title={intl.formatMessage({ id: 'account.title' })}
          onClose={() => setOpen(false)}
          testid="account-switcher-sheet"
        >
          <FourState
            isLoading={isLoading && !data}
            isError={isError && !data}
            isEmpty={false}
            onRetry={() => void refetch()}
            testid="account-switcher-list"
          >
            <AccountManagerList
              accounts={accounts}
              activeIndex={active.activeIndex ?? 0}
              canRemove={accounts.length > 1}
              onDone={() => setOpen(false)}
            />
          </FourState>
        </Sheet>
      )}
    </div>
  );
}

/** The account list + the add-account form below it. */
function AccountManagerList({
  accounts,
  activeIndex,
  canRemove,
  onDone,
}: {
  accounts: AccountEntry[];
  activeIndex: number;
  canRemove: boolean;
  onDone: () => void;
}) {
  const intl = useIntl();
  const [addAccount, addState] = useAddAccountMutation();
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function doAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await addAccount({ label: newLabel.trim() || undefined });
    if ('data' in res) setNewLabel('');
    else setError(intl.formatMessage({ id: 'account.error.generic' }));
  }

  return (
    <>
      <ul className="dig-switcher-list" data-testid="account-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {accounts.map((a) => (
          <li key={a.id}>
            <AccountRow account={a} isActive={a.index === activeIndex} canRemove={canRemove} onDone={onDone} />
          </li>
        ))}
      </ul>

      <form onSubmit={doAdd} className="dig-switcher-row-form" style={{ marginTop: 12 }} data-testid="account-add-form">
        <input
          className="dig-input"
          data-testid="account-add-input"
          value={newLabel}
          maxLength={40}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder={intl.formatMessage({ id: 'account.new.placeholder' })}
          aria-label={intl.formatMessage({ id: 'account.new.placeholder' })}
        />
        <button type="submit" className="dig-btn dig-btn--primary" data-testid="account-add-submit" disabled={addState.isLoading}>
          <FormattedMessage id="account.add" />
        </button>
      </form>
      {error && (
        <p className="dig-error-text" role="alert" data-testid="account-add-error" style={{ marginBottom: 0 }}>
          {error}
        </p>
      )}
    </>
  );
}

/** One account row: switch (active-aware), rename (inline), remove (two-step confirm, never last). */
function AccountRow({
  account,
  isActive,
  canRemove,
  onDone,
}: {
  account: AccountEntry;
  isActive: boolean;
  canRemove: boolean;
  onDone: () => void;
}) {
  const intl = useIntl();
  const [setActiveIndex, switchState] = useSetActiveIndexMutation();
  const [renameAccount, renameState] = useRenameAccountMutation();
  const [removeAccount, removeState] = useRemoveAccountMutation();
  const [mode, setMode] = useState<'idle' | 'rename' | 'confirmRemove'>('idle');
  const [name, setName] = useState(account.label);
  const [error, setError] = useState<string | null>(null);

  const busy = switchState.isLoading || renameState.isLoading || removeState.isLoading;

  async function doSwitch() {
    setError(null);
    const res = await setActiveIndex({ index: account.index });
    if ('data' in res) onDone();
    else setError(intl.formatMessage({ id: 'account.error.generic' }));
  }

  async function doRename() {
    setError(null);
    const label = name.trim();
    if (!label) return;
    const res = await renameAccount({ accountId: account.id, label });
    if ('data' in res) setMode('idle');
    else setError(intl.formatMessage({ id: 'account.error.generic' }));
  }

  async function doRemove() {
    setError(null);
    const res = await removeAccount({ accountId: account.id });
    if ('data' in res) {
      setMode('idle');
      return;
    }
    const code = (res.error as { code?: string } | undefined)?.code;
    setError(intl.formatMessage({ id: code === 'LAST_ACCOUNT' ? 'account.error.lastAccount' : 'account.error.generic' }));
    setMode('idle');
  }

  return (
    <div className="dig-switcher-row" data-testid={`account-row-${account.id}`}>
      {mode === 'rename' ? (
        <form onSubmit={(e) => { e.preventDefault(); void doRename(); }} className="dig-switcher-row-form">
          <input
            className="dig-input"
            data-testid={`account-rename-input-${account.id}`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label={intl.formatMessage({ id: 'account.rename.placeholder' })}
            autoFocus
          />
          <button type="submit" className="dig-btn dig-btn--primary" data-testid={`account-rename-save-${account.id}`} disabled={busy || !name.trim()}>
            <FormattedMessage id="account.rename.save" />
          </button>
          <button type="button" className="dig-btn" data-testid={`account-rename-cancel-${account.id}`} onClick={() => { setName(account.label); setMode('idle'); }}>
            <FormattedMessage id="account.cancel" />
          </button>
        </form>
      ) : (
        <div className="dig-switcher-row-main">
          <button
            type="button"
            className="dig-switcher-select"
            data-testid={`account-switch-${account.id}`}
            onClick={() => void doSwitch()}
            disabled={busy}
            aria-current={isActive ? 'true' : undefined}
          >
            <span className="dig-switcher-row-text">
              <span className="dig-switcher-rowname">{account.label}</span>
              <span className="dig-switcher-row-address dig-muted" data-testid={`account-index-${account.id}`}>
                <FormattedMessage id="account.index" values={{ index: account.index }} />
              </span>
            </span>
            {isActive && (
              <span className="dig-badge" data-testid={`account-active-${account.id}`}>
                <FormattedMessage id="account.active.badge" />
              </span>
            )}
          </button>
          <button type="button" className="dig-iconbtn" data-testid={`account-rename-${account.id}`} aria-label={intl.formatMessage({ id: 'account.rename' })} title={intl.formatMessage({ id: 'account.rename' })} onClick={() => { setName(account.label); setMode('rename'); }}>
            ✎
          </button>
          {canRemove && (
            <button type="button" className="dig-iconbtn" data-testid={`account-remove-${account.id}`} aria-label={intl.formatMessage({ id: 'account.remove' })} title={intl.formatMessage({ id: 'account.remove' })} onClick={() => setMode('confirmRemove')}>
              🗑
            </button>
          )}
        </div>
      )}

      {mode === 'confirmRemove' && (
        <div data-testid={`account-remove-confirm-${account.id}`} className="dig-switcher-row-expand">
          <p className="dig-muted" role="alert" style={{ marginTop: 0 }}>
            <FormattedMessage id="account.remove.prompt" values={{ label: account.label, index: account.index }} />
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dig-btn dig-btn--danger" data-testid={`account-remove-yes-${account.id}`} onClick={() => void doRemove()} disabled={busy}>
              <FormattedMessage id="account.remove.confirm" />
            </button>
            <button type="button" className="dig-btn" data-testid={`account-remove-no-${account.id}`} onClick={() => setMode('idle')}>
              <FormattedMessage id="account.cancel" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="dig-error-text" role="alert" data-testid={`account-row-error-${account.id}`} style={{ marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
