import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { AssetFilterField } from '@/features/wallet/custody/AssetFilterField';

describe('AssetFilterField', () => {
  it('renders the current value and reports changes as the user types', () => {
    const onChange = vi.fn();
    renderWithProviders(<AssetFilterField value="" onChange={onChange} suggestions={[]} testid="asset-filter" />);
    const input = screen.getByTestId('asset-filter-input');
    fireEvent.change(input, { target: { value: 'sbx' } });
    expect(onChange).toHaveBeenCalledWith('sbx');
  });

  it('lists autocomplete suggestions in a datalist tied to the input', () => {
    renderWithProviders(
      <AssetFilterField value="sb" onChange={() => {}} suggestions={[{ ticker: 'SBX', name: 'Spacebucks' }]} testid="asset-filter" />,
    );
    const input = screen.getByTestId('asset-filter-input') as HTMLInputElement;
    expect(input.getAttribute('list')).toBeTruthy();
    // `.list` resolves the associated <datalist> via the input's `list` IDREF — avoids constructing
    // a CSS id selector out of React's `useId()` value (which contains `:`, invalid unescaped).
    const option = input.list?.querySelector('option') as HTMLOptionElement;
    expect(option.value).toBe('SBX');
  });

  it('shows no clear button when the value is empty', () => {
    renderWithProviders(<AssetFilterField value="" onChange={() => {}} suggestions={[]} testid="asset-filter" />);
    expect(screen.queryByTestId('asset-filter-clear')).not.toBeInTheDocument();
  });

  it('clears the value when the clear button is clicked', () => {
    const onChange = vi.fn();
    renderWithProviders(<AssetFilterField value="sbx" onChange={onChange} suggestions={[]} testid="asset-filter" />);
    fireEvent.click(screen.getByTestId('asset-filter-clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('is accessibly labelled', () => {
    renderWithProviders(<AssetFilterField value="" onChange={() => {}} suggestions={[]} testid="asset-filter" />);
    expect(screen.getByRole('searchbox')).toHaveAccessibleName();
  });
});
