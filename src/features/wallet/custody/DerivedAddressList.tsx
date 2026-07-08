import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { FourState } from '@/components/FourState';
import { shortenAddress } from '@/lib/wallet-view';
import { useGetDerivedAddressesQuery, type DerivedAddress } from '@/features/wallet/custodyApi';

const PAGE_SIZE = 5;

/**
 * Derived-address list (#106) — an ADVANCED-tier view/copy list of the active wallet's derived
 * addresses, BOTH HD schemes, starting at index 0. Pure local derivation (no chain query): this is
 * NOT a balance/activity scan and does NOT touch the single active-derivation-index model (#165) —
 * it never changes which index the rest of the wallet operates on, it only lists addresses for
 * inspection/copying. "Generate fresh" extends the page (more indexes), it never replaces it, so a
 * previously-copied address stays visible.
 */
export function DerivedAddressList() {
  const intl = useIntl();
  const [count, setCount] = useState(PAGE_SIZE);
  const { data, isLoading, isError, isFetching, refetch } = useGetDerivedAddressesQuery({ count });
  const addresses = data?.addresses ?? [];
  const unhardened = addresses.filter((a) => a.scheme === 'unhardened');
  const hardened = addresses.filter((a) => a.scheme === 'hardened');

  return (
    <section className="dig-card" data-testid="derived-addresses" aria-labelledby="derived-addresses-title">
      <h2 className="dig-heading" id="derived-addresses-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="addresses.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="addresses.subtitle" />
      </p>
      <FourState
        isLoading={isLoading}
        isError={isError}
        isEmpty={false}
        onRetry={refetch}
        testid="derived-addresses"
      >
        <AddressScheme titleId="addresses.scheme.unhardened" rows={unhardened} />
        <AddressScheme titleId="addresses.scheme.hardened" rows={hardened} />
        <button
          type="button"
          className="dig-btn dig-btn--ghost dig-btn--block"
          data-testid="derived-addresses-more"
          disabled={isFetching}
          onClick={() => setCount((c) => c + PAGE_SIZE)}
        >
          <FormattedMessage id={isFetching ? 'custody.working' : 'addresses.more'} />
        </button>
      </FourState>
      {/* Announce a fetch-more in flight without hiding the already-shown addresses (loading ≠
          unavailable, #158) — the button's own disabled+label state already carries this, this is
          for assistive tech. */}
      <p className="dig-sr-only" role="status" aria-live="polite">
        {isFetching ? intl.formatMessage({ id: 'custody.working' }) : ''}
      </p>
    </section>
  );
}

/** One scheme's group of derived-address rows (unhardened or hardened), each with a copy button. */
function AddressScheme({ titleId, rows }: { titleId: string; rows: DerivedAddress[] }) {
  return (
    <div style={{ margin: '10px 0' }}>
      <h3 className="dig-muted" style={{ margin: '0 0 6px', fontSize: '0.85em', textTransform: 'uppercase' }}>
        <FormattedMessage id={titleId} />
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((row) => (
          <AddressRow key={`${row.scheme}-${row.index}`} row={row} />
        ))}
      </ul>
    </div>
  );
}

/** One derived-address row: index + shortened address + a Copy button (copies the FULL address). */
function AddressRow({ row }: { row: DerivedAddress }) {
  const [copied, setCopied] = useState(false);
  const testKey = `${row.scheme}-${row.index}`;

  function onCopy() {
    navigator.clipboard?.writeText(row.address)?.then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  }

  return (
    <li
      data-testid={`derived-address-${testKey}`}
      style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--dig-border)' }}
    >
      <div style={{ minWidth: 0 }}>
        <span className="dig-muted" style={{ fontSize: '0.8em' }}>
          <FormattedMessage id="wallet.index.label" values={{ index: row.index }} />
        </span>
        <p className="dig-mono" style={{ margin: '2px 0 0', wordBreak: 'break-all' }} title={row.address}>
          {shortenAddress(row.address)}
        </p>
      </div>
      <button type="button" className="dig-btn dig-btn--ghost" data-testid={`derived-address-copy-${testKey}`} onClick={onCopy}>
        <FormattedMessage id={copied ? 'addresses.copied' : 'addresses.copy'} />
      </button>
    </li>
  );
}
