import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { axe } from 'jest-axe';
import { NftImageLightbox } from '@/features/collectibles/NftImageLightbox';
import { messagesFor, DEFAULT_LOCALE } from '@/i18n';

afterEach(() => vi.restoreAllMocks());

function renderLightbox(onClose = vi.fn()) {
  const result = render(
    <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
      <button data-testid="page-trigger">Open</button>
      <NftImageLightbox src="blob:mock-1" label="NFT ab12…cd34 — full image" onClose={onClose} />
    </IntlProvider>,
  );
  return { onClose, ...result };
}

describe('NftImageLightbox (#173 a11y dialog mechanics)', () => {
  it('is a labelled modal dialog showing the given image, and moves focus into itself on open', () => {
    renderLightbox();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'NFT ab12…cd34 — full image');
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByTestId('nft-lightbox-image')).toHaveAttribute('src', 'blob:mock-1');
  });

  it('closes on Escape, on a backdrop click, and via the labelled close button — never on a click inside the image', () => {
    const { onClose } = renderLightbox();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId('nft-lightbox')); // backdrop is the testid root
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(screen.getByTestId('nft-lightbox-image'));
    expect(onClose).toHaveBeenCalledTimes(2); // unchanged — a click ON the image must not close it

    fireEvent.click(screen.getByTestId('nft-lightbox-close'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('labels the close button for screen readers', () => {
    renderLightbox();
    expect(screen.getByTestId('nft-lightbox-close')).toHaveAttribute('aria-label', 'Close');
  });

  it('TRAPS Tab within the dialog (the close button is the only focusable control, so focus never leaves it)', () => {
    renderLightbox();
    const close = screen.getByTestId('nft-lightbox-close');

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('restores focus to the page element that had it (the trigger) on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderLightbox();
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('has no WCAG violations', async () => {
    const { container } = renderLightbox();
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('portals to document.body — escapes a `.dig-screen` ancestor so it is never confined/mis-stacked (#200)', () => {
    const { container } = render(
      <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
        <div className="dig-screen">
          <NftImageLightbox src="blob:mock-1" label="NFT ab12…cd34 — full image" onClose={() => {}} />
        </div>
      </IntlProvider>,
    );
    const dialog = screen.getByRole('dialog');
    const screenEl = container.querySelector('.dig-screen');
    expect(screenEl).not.toBeNull();
    expect(screenEl?.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});
