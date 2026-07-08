import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sheet } from '@/components/Sheet';

afterEach(() => vi.restoreAllMocks());

function renderSheet(onClose = vi.fn()) {
  const result = render(
    <Sheet title="Send" onClose={onClose} testid="sheet">
      <button data-testid="first">First</button>
      <input data-testid="mid" />
      <button data-testid="last">Last</button>
    </Sheet>,
  );
  return { onClose, ...result };
}

describe('Sheet (modal a11y)', () => {
  it('is a labelled modal dialog and moves focus into itself on open', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Send');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Escape and on a backdrop click', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByTestId('sheet')); // backdrop is the testid root
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('TRAPS Tab within the dialog (focus cannot escape to the page behind)', () => {
    renderSheet();
    // The close button (✕) sits in the head, so it is the FIRST focusable; `last` is the last.
    const firstFocusable = screen.getByTestId('sheet-close');
    const last = screen.getByTestId('last');

    // Tab forward from the last focusable wraps to the first (not out to the page).
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstFocusable);

    // Shift+Tab from the first focusable wraps back to the last.
    firstFocusable.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('portals to document.body — escapes a `.dig-screen` ancestor so it is never confined/mis-stacked (#200)', () => {
    const { container } = render(
      <div className="dig-screen">
        <Sheet title="Send" onClose={() => {}} testid="sheet">
          <button data-testid="first">First</button>
        </Sheet>
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    const screenEl = container.querySelector('.dig-screen');
    expect(screenEl).not.toBeNull();
    expect(screenEl?.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
