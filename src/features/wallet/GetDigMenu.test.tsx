import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { GetDigMenu } from '@/features/wallet/GetDigMenu';
import { renderWithProviders } from '@/test/harness';
import { GET_DIG_SOURCES } from '@/lib/links';

/**
 * #202 — the "Get more $DIG" affordance rendered next to the $DIG asset row: a subtle trigger that
 * opens a small menu of the three canonical acquisition venues (mirrors hub's `GetDigMenu`), in the
 * SAME order as {@link GET_DIG_SOURCES} (TibetSwap, dexie, 9mm.pro).
 */
describe('GetDigMenu', () => {
  it('renders a closed, accessible trigger by default (no menu in the DOM)', () => {
    renderWithProviders(<GetDigMenu />);
    const trigger = screen.getByTestId('getdig-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('getdig-menu')).not.toBeInTheDocument();
  });

  it('opens the menu with exactly the 3 canonical venues, in order, with the correct URLs', () => {
    renderWithProviders(<GetDigMenu />);
    fireEvent.click(screen.getByTestId('getdig-trigger'));

    const menu = screen.getByTestId('getdig-menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId('getdig-trigger')).toHaveAttribute('aria-expanded', 'true');

    const links = screen.getAllByRole('menuitem') as HTMLAnchorElement[];
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(GET_DIG_SOURCES.map((s) => s.url));
    expect(links[0]).toHaveTextContent('TibetSwap');
    expect(links[1]).toHaveTextContent('dexie');
    expect(links[2]).toHaveTextContent('9mm.pro');
    // Every venue link opens in a new tab, never navigating the wallet away.
    for (const l of links) expect(l).toHaveAttribute('target', '_blank');
  });

  it('closes the menu on a second trigger click', () => {
    renderWithProviders(<GetDigMenu />);
    const trigger = screen.getByTestId('getdig-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('getdig-menu')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('getdig-menu')).not.toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    renderWithProviders(<GetDigMenu />);
    fireEvent.click(screen.getByTestId('getdig-trigger'));
    expect(screen.getByTestId('getdig-menu')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('getdig-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('getdig-menu')).not.toBeInTheDocument();
  });

  it('closes the menu on an outside click', () => {
    renderWithProviders(
      <div>
        <GetDigMenu />
        <button type="button" data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByTestId('getdig-trigger'));
    expect(screen.getByTestId('getdig-menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('getdig-menu')).not.toBeInTheDocument();
  });
});
