import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { FeeField } from '@/features/wallet/custody/FeeField';
import { formatBaseUnits } from '@/lib/wallet-view';
import { SETTINGS_KEY } from '@/features/wallet/custody/settings';

const XCH = 12;
const OK = { estimates: [700, 300, 100], target_times: [60, 120, 300], success: true };

/** A controlled host so tests can observe the fee value the field pushes up to its parent. */
function Harness() {
  const [fee, setFee] = useState('0');
  return (
    <>
      <FeeField fee={fee} onFee={setFee} />
      <output data-testid="fee-value">{fee}</output>
    </>
  );
}

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(async () => {
  // readWalletSettings reads chrome.storage.local — cleared → the coinset default endpoint.
  await chrome.storage.local.remove(SETTINGS_KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FeeField (#206/#110)', () => {
  it('shows a loading indicator while the estimate is fetching (#158)', async () => {
    stubFetch(() => new Promise(() => {})); // never resolves
    renderWithProviders(<Harness />);
    expect(await screen.findByTestId('fee-estimating')).toBeInTheDocument();
  });

  it('defaults to the estimated normal fee as a read-only line item with presets + Override', async () => {
    stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
    renderWithProviders(<Harness />);

    // The read-only estimate line renders once loaded, and the parent fee = the normal estimate.
    expect(await screen.findByTestId('fee-line')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('fee-value')).toHaveTextContent(formatBaseUnits(300, XCH)));
    // The three presets are offered (#110); normal is selected by default.
    expect(screen.getByTestId('fee-preset-fast')).toBeInTheDocument();
    expect(screen.getByTestId('fee-preset-normal')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('fee-preset-slow')).toBeInTheDocument();
    // No editable input by default — bias toward accepting the estimate (#206).
    expect(screen.queryByTestId('fee-override-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('fee-override-toggle')).toBeInTheDocument();
  });

  it('selecting a preset changes the fee (#110)', async () => {
    stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
    renderWithProviders(<Harness />);
    await screen.findByTestId('fee-line');

    fireEvent.click(screen.getByTestId('fee-preset-fast'));
    await waitFor(() => expect(screen.getByTestId('fee-value')).toHaveTextContent(formatBaseUnits(700, XCH)));
    expect(screen.getByTestId('fee-preset-fast')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByTestId('fee-preset-slow'));
    await waitFor(() => expect(screen.getByTestId('fee-value')).toHaveTextContent(formatBaseUnits(100, XCH)));
  });

  it('Override reveals an editable input; Use estimate reverts to the preset (#206)', async () => {
    stubFetch(async () => new Response(JSON.stringify(OK), { status: 200 }));
    renderWithProviders(<Harness />);
    await screen.findByTestId('fee-line');

    fireEvent.click(screen.getByTestId('fee-override-toggle'));
    const input = await screen.findByTestId('fee-override-input');
    fireEvent.change(input, { target: { value: '0.005' } });
    expect(screen.getByTestId('fee-value')).toHaveTextContent('0.005');

    // Reverting re-applies the currently-selected estimate preset (normal).
    fireEvent.click(screen.getByTestId('fee-use-estimate'));
    await waitFor(() => expect(screen.getByTestId('fee-value')).toHaveTextContent(formatBaseUnits(300, XCH)));
    expect(screen.queryByTestId('fee-override-input')).not.toBeInTheDocument();
  });

  it('on estimate failure falls back to a sane default + honest note + allows override', async () => {
    stubFetch(async () => new Response('nope', { status: 503 }));
    renderWithProviders(<Harness />);

    expect(await screen.findByTestId('fee-error')).toBeInTheDocument();
    // Fallback fee is the sane default (0), and the user can still enter a value.
    expect(screen.getByTestId('fee-value')).toHaveTextContent('0');
    expect(screen.getByTestId('fee-override-input')).toBeInTheDocument();
  });
});
