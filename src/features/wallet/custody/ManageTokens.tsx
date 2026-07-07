import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useStorageValue } from '@/lib/useStorageValue';
import { addWatchedCat, addHiddenCat, removeHiddenCat, parseHiddenCats } from '@/lib/wallet-assets';
import { useGetCatRegistryQuery } from '@/features/wallet/catMetadataApi';
import { resolveCatMeta } from '@/features/wallet/catMetadata';
import { AssetRow } from '@/components/AssetRow';
import { ViewHeader } from '@/components/ViewHeader';
import type { AssetBalance } from '@/features/wallet/assetTypes';

/**
 * Manage tokens (#87 + #95) — the surface where the user curates their token list. It's
 * discovery-first: every CAT the wallet holds already appears automatically (auto-discovery), so this
 * screen is for the exceptions — HIDE a discovered token you don't want to see, SHOW one you hid, or
 * ADD a token manually by its asset id (a CAT held only as un-hinted change, or one you want pinned
 * before it's received). Hiding never forgets coins; it only suppresses the row.
 *
 * `assets` is the already-built, discovery + metadata-enriched, hidden-filtered list (from
 * `custodyAssetBalances`) — so "Your tokens" reuses the exact same rows as the wallet. Hidden tokens
 * are resolved for display straight from the registry.
 */
export function ManageTokens({ assets, onClose }: { assets: AssetBalance[]; onClose?: () => void }) {
  const intl = useIntl();
  const registry = useGetCatRegistryQuery();
  const [watched, setWatched] = useStorageValue<unknown>('wallet.watchedCats', []);
  const [hidden, setHidden] = useStorageValue<unknown>('wallet.hiddenCats', []);

  const [idInput, setIdInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [errorId, setErrorId] = useState<string | null>(null);

  // Visible CAT rows (exclude native XCH; keep $DIG + discovered + watched).
  const catRows = assets.filter((a) => a.descriptor.type === 'cat' && a.descriptor.assetId);
  const hiddenTails = parseHiddenCats(hidden);

  function hide(tail: string) {
    setHidden(addHiddenCat(hidden, tail));
  }
  function show(tail: string) {
    setHidden(removeHiddenCat(hidden, tail));
  }
  function add(e: React.FormEvent) {
    e.preventDefault();
    const res = addWatchedCat(watched, idInput, nameInput);
    if (!res.ok) {
      setErrorId(res.error);
      return;
    }
    setWatched(res.list);
    // If the token was previously hidden, adding it explicitly un-hides it so it shows.
    setHidden(removeHiddenCat(hidden, idInput));
    setIdInput('');
    setNameInput('');
    setErrorId(null);
  }

  return (
    <div data-testid="manage-tokens">
      <ViewHeader
        onBack={onClose}
        backLabel={<FormattedMessage id="tokens.manage.close" />}
        backTestId="manage-tokens-close"
        title={<FormattedMessage id="tokens.manage.title" />}
        titleId="manage-tokens-title"
      />
      <section className="dig-card" aria-labelledby="manage-tokens-title">
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="tokens.manage.intro" />
      </p>

      <h3 className="dig-heading" style={{ fontSize: 14, marginTop: 16 }}>
        <FormattedMessage id="tokens.manage.yourTokens" />
      </h3>
      {catRows.length === 0 ? (
        <p className="dig-muted" data-testid="manage-tokens-empty">
          <FormattedMessage id="tokens.manage.empty" />
        </p>
      ) : (
        <ul className="dig-token-manage-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {catRows.map((a) => (
            <li key={a.descriptor.assetId} className="dig-token-manage-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <AssetRow
                  ticker={a.descriptor.ticker}
                  name={a.descriptor.name}
                  amountLabel={a.label}
                  fiatLabel={null}
                  iconUrl={a.descriptor.iconUrl}
                  testid={`manage-token-${a.descriptor.assetId}`}
                />
              </div>
              <button
                type="button"
                className="dig-btn dig-btn--sm"
                data-testid={`manage-hide-${a.descriptor.assetId}`}
                onClick={() => hide(a.descriptor.assetId!)}
              >
                <FormattedMessage id="tokens.manage.hide" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {hiddenTails.length > 0 && (
        <>
          <h3 className="dig-heading" style={{ fontSize: 14, marginTop: 16 }}>
            <FormattedMessage id="tokens.manage.hidden" />
          </h3>
          <ul className="dig-token-manage-list" data-testid="manage-hidden-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {hiddenTails.map((tail) => {
              const meta = resolveCatMeta(tail, registry.data);
              return (
                <li key={tail} className="dig-token-manage-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AssetRow ticker={meta.ticker} name={meta.name} amountLabel="—" fiatLabel={null} iconUrl={meta.iconUrl} testid={`manage-hidden-${tail}`} />
                  </div>
                  <button type="button" className="dig-btn dig-btn--sm" data-testid={`manage-show-${tail}`} onClick={() => show(tail)}>
                    <FormattedMessage id="tokens.manage.show" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3 className="dig-heading" style={{ fontSize: 14, marginTop: 16 }}>
        <FormattedMessage id="tokens.manage.add.title" />
      </h3>
      <form onSubmit={add} data-testid="manage-add-form">
        <label className="dig-field">
          <span><FormattedMessage id="tokens.manage.add.assetId" /></span>
          <input
            className="dig-input dig-mono"
            data-testid="manage-add-id"
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={intl.formatMessage({ id: 'tokens.manage.add.placeholder' })}
          />
        </label>
        <label className="dig-field">
          <span><FormattedMessage id="tokens.manage.add.name" /></span>
          <input
            className="dig-input"
            data-testid="manage-add-name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            autoComplete="off"
            maxLength={40}
          />
        </label>
        {errorId && (
          <p className="dig-error-text" role="alert" data-testid="manage-add-error">
            <FormattedMessage id={errorId} />
          </p>
        )}
        <button type="submit" className="dig-btn dig-btn--primary dig-btn--block" data-testid="manage-add-submit">
          <FormattedMessage id="tokens.manage.add.button" />
        </button>
      </form>
      </section>
    </div>
  );
}
