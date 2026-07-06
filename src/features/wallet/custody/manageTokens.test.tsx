import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageTokens } from '@/features/wallet/custody/ManageTokens';
import { custodyAssetBalances } from '@/features/wallet/custody/balances';
import { renderWithProviders } from '@/test/harness';

/**
 * ManageTokens (#87/#95) — the discovery-first curation surface. Held tokens list automatically;
 * the user can hide/show them and add one manually. Storage is the in-memory chrome mock; the
 * registry fetch is stubbed to fail so rows use the graceful short-form fallback (deterministic).
 */

const CAT = 'a'.repeat(64);

// Stub the registry fetch so no real network is hit; the short-form fallback still renders rows.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch);
});

function heldAssets() {
  return custodyAssetBalances({ xch: 1_000_000_000_000, cats: { [CAT]: 4200 } }, []);
}

describe('ManageTokens', () => {
  it('lists held tokens (discovered) and offers a Hide control', () => {
    renderWithProviders(<ManageTokens assets={heldAssets()} />);
    expect(screen.getByTestId('manage-tokens')).toBeInTheDocument();
    // The discovered CAT appears with a Hide button (DIG built-in also present).
    expect(screen.getByTestId(`manage-hide-${CAT}`)).toBeInTheDocument();
  });

  it('hides a token → it moves to the Hidden section with a Show control', async () => {
    renderWithProviders(<ManageTokens assets={heldAssets()} />);
    fireEvent.click(screen.getByTestId(`manage-hide-${CAT}`));
    await waitFor(() => expect(screen.getByTestId(`manage-show-${CAT}`)).toBeInTheDocument());
  });

  it('rejects an invalid manual add with a localized error', async () => {
    renderWithProviders(<ManageTokens assets={heldAssets()} />);
    await userEvent.type(screen.getByTestId('manage-add-id'), 'not-a-tail');
    fireEvent.submit(screen.getByTestId('manage-add-form'));
    await waitFor(() => expect(screen.getByTestId('manage-add-error')).toBeInTheDocument());
  });

  it('adds a valid token by asset id (clears the form)', async () => {
    renderWithProviders(<ManageTokens assets={heldAssets()} />);
    const id = 'b'.repeat(64);
    const input = screen.getByTestId('manage-add-id') as HTMLInputElement;
    await userEvent.type(input, id);
    fireEvent.submit(screen.getByTestId('manage-add-form'));
    await waitFor(() => expect((screen.getByTestId('manage-add-id') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByTestId('manage-add-error')).toBeNull();
  });
});
