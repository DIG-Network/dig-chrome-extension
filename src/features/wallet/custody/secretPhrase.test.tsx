import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { SecretPhrase } from '@/features/wallet/custody/SecretPhrase';

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

afterEach(() => vi.restoreAllMocks());

describe('SecretPhrase', () => {
  it('renders the words into a CLOSED shadow root, not the light DOM', () => {
    // Spy on attachShadow so we can inspect the (otherwise unreachable) closed root it returns.
    const attachSpy = vi.spyOn(Element.prototype, 'attachShadow');
    const { getByTestId, container } = render(<SecretPhrase words={WORDS} ariaLabel="phrase" />);

    // A closed root — the mode a page/other-extension cannot reach via `host.shadowRoot`.
    expect(attachSpy).toHaveBeenCalledWith({ mode: 'closed' });
    const shadow = attachSpy.mock.results[0]!.value as ShadowRoot;

    // The 24 words really did render — inside the shadow subtree, with the aria-label for SRs.
    const list = shadow.querySelector('ol');
    expect(list?.getAttribute('aria-label')).toBe('phrase');
    expect(shadow.querySelectorAll('li')).toHaveLength(24);
    expect(shadow.textContent).toContain('word1');

    // ...but NONE of it is scrapeable from the light DOM.
    const host = getByTestId('recovery-words');
    expect(host.shadowRoot).toBeNull(); // closed → null from outside
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(container.textContent).not.toContain('word1');
    expect(host.getAttribute('data-word-count')).toBe('24');
  });

  it('accepts a custom testid', () => {
    const { getByTestId } = render(<SecretPhrase words={WORDS} ariaLabel="phrase" testid="pk-reveal" />);
    expect(getByTestId('pk-reveal').getAttribute('data-word-count')).toBe('24');
  });
});
