import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { FiatCurrencySetting } from '@/features/wallet/custody/FiatCurrencySetting';
import { renderWithProviders } from '@/test/harness';
import { SUPPORTED_FIAT_CURRENCIES } from '@/features/wallet/fiatCurrency';

describe('FiatCurrencySetting (#112)', () => {
  it('lists every supported currency, with the current value selected', () => {
    renderWithProviders(<FiatCurrencySetting value="eur" onChange={() => {}} />);
    const select = screen.getByTestId('fiat-currency-select') as HTMLSelectElement;
    expect(select.value).toBe('eur');
    const options = [...select.options].map((o) => o.value);
    expect(options).toEqual(SUPPORTED_FIAT_CURRENCIES.map((c) => c.code));
  });

  it('calls onChange with the newly picked currency code', () => {
    const onChange = vi.fn();
    renderWithProviders(<FiatCurrencySetting value="usd" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('fiat-currency-select'), { target: { value: 'jpy' } });
    expect(onChange).toHaveBeenCalledWith('jpy');
  });

  it('has an accessible label', () => {
    renderWithProviders(<FiatCurrencySetting value="usd" onChange={() => {}} />);
    expect(screen.getByTestId('fiat-currency-select')).toHaveAccessibleName();
  });
});
