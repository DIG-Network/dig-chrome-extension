import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import '@/features/wallet/custody/WalletSwitcher.css';
import { Sheet } from '@/components/Sheet';
import { FourState } from '@/components/FourState';
import { Onboarding } from '@/features/wallet/custody/Onboarding';
import { WalletIdenticon } from '@/features/wallet/custody/WalletIdenticon';
import { WalletManagerList } from '@/features/wallet/custody/WalletManagerList';
import {
  useListWalletsQuery,
  useGetReceiveAddressQuery,
  useLockWalletMutation,
} from '@/features/wallet/custodyApi';
import { shortenAddress } from '@/lib/wallet-view';
import type { WalletMeta } from '@/lib/wallet-registry';

/**
 * The active-wallet switcher (#90, redesigned #176) — the shell control that holds SEVERAL wallets
 * and switches the active one. A compact pill (a small identicon + the active wallet's label) opens
 * an accessible manager Sheet: a prominent {@link CurrentWalletCard} up top (identicon + label + the
 * live receive address, copyable), then the full {@link WalletManagerList} below (every wallet,
 * switch/rename/remove — the active one included, marked with the Active badge, so there is exactly
 * ONE management surface, not a duplicate). Kept inline rather than split into a separate
 * fullscreen-only management view: at the popup's fixed 372px width this still fits without
 * horizontal overflow (#163), so the simpler single-surface design wins (#176's own "OR inline if
 * it stays simple" allowance).
 *
 * Switching to a wallet whose key isn't cached this session returns NEEDS_UNLOCK; the row then
 * expands into a password prompt (unlock-then-activate) — the decrypted key never leaves the vault.
 * A successful switch resets the whole RTK Query cache (#162) so every wallet-scoped view falls back
 * to its loading state instead of showing the previous wallet's data under the new identity.
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
  const activeSeed = active?.previewAddress ?? active?.id ?? '';

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
        <WalletIdenticon seed={activeSeed} size={18} />
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
              <CurrentWalletCard wallet={active} />
              <WalletManagerList wallets={wallets} onDone={close} />
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
 * The prominent "which wallet am I in" summary at the top of the manager sheet: a bigger identicon,
 * the label, and the live receive address (truncated, with a copy button) — purely a glanceable
 * display, no rename/remove here (those live on this SAME wallet's row in {@link WalletManagerList}
 * right below, so there is exactly one place that mutates a wallet, never two diverging UIs for the
 * same action). The address is the REAL live query (not the cached `previewAddress`, which exists
 * so *other* wallets can show a preview without being unlocked) — the active wallet is always
 * unlocked, so this always reflects its current index-0-or-whatever-index-is-active address exactly.
 */
function CurrentWalletCard({ wallet }: { wallet: WalletMeta | undefined }) {
  const intl = useIntl();
  const { data } = useGetReceiveAddressQuery();
  const [copied, setCopied] = useState(false);
  const address = data?.address;
  const seed = wallet?.previewAddress ?? wallet?.id ?? '';
  const label = wallet?.label ?? intl.formatMessage({ id: 'wallet.switcher.fallback' });
  const copyLabel = intl.formatMessage({ id: copied ? 'wallet.switcher.addressCopied' : 'wallet.switcher.copyAddress' });

  function onCopy() {
    if (!address) return;
    // Optional-chain the promise too — jsdom / older contexts may lack navigator.clipboard.
    navigator.clipboard?.writeText(address)?.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  }

  return (
    <div className="dig-current-wallet" data-testid="wallet-switcher-current">
      <WalletIdenticon seed={seed} size={40} />
      <div className="dig-current-wallet-info">
        <p className="dig-section-title" style={{ margin: '0 0 2px' }}>
          <FormattedMessage id="wallet.switcher.current" />
        </p>
        <p className="dig-current-wallet-label" data-testid="wallet-switcher-current-label">
          {label}
        </p>
        <p className="dig-current-wallet-address dig-mono" data-testid="wallet-switcher-current-address">
          {address ? shortenAddress(address, 14, 10) : '…'}
        </p>
      </div>
      {address && (
        <button
          type="button"
          className="dig-iconbtn"
          data-testid="wallet-switcher-current-copy"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={onCopy}
        >
          {copied ? '✓' : '⧉'}
        </button>
      )}
    </div>
  );
}
