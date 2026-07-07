import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ViewHeader } from '@/components/ViewHeader';

/**
 * #166 — the shared sticky-top-header primitive. Every screen-style view (Send, Receive, NFT/DID
 * detail, offers, …) puts its back/close affordance here instead of at the bottom of its own
 * (possibly growable) body, so it is reachable at any scroll position (§6.5). These are structural/
 * behavioral unit tests; the actual "stays pinned while scrolling" CSS is exercised end-to-end in
 * `e2e/sw/view-header-receive.spec.ts` against the real built popup.
 */
describe('ViewHeader', () => {
  it('renders inside a <header> element (the sticky-header region), not a footer/bottom element', () => {
    renderWithProviders(<ViewHeader onBack={() => {}} backLabel="Back" title="A Screen" />);
    const header = screen.getByTestId('view-header');
    expect(header.tagName).toBe('HEADER');
    // The back button lives INSIDE the header region — this is the structural guard the issue asks
    // for ("a test/lint guard ... that back is in the header region, not the bottom").
    expect(header).toContainElement(screen.getByTestId('view-header-back'));
  });

  it('invokes onBack when the back button is clicked, and uses the caller-provided label + testid', () => {
    const onBack = vi.fn();
    renderWithProviders(<ViewHeader onBack={onBack} backLabel="Cancel" backTestId="my-back" />);
    const btn = screen.getByTestId('my-back');
    expect(btn).toHaveTextContent('Cancel');
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no back button when onBack is omitted (title-only header)', () => {
    renderWithProviders(<ViewHeader title="Read-only screen" />);
    expect(screen.queryByTestId('view-header-back')).not.toBeInTheDocument();
    expect(screen.getByText('Read-only screen')).toBeInTheDocument();
  });

  it('renders the title as a labelled heading with the given id, for aria-labelledby wiring', () => {
    renderWithProviders(<ViewHeader title="Send" titleId="send-title" />);
    const heading = screen.getByRole('heading', { name: 'Send' });
    expect(heading.id).toBe('send-title');
  });

  it('renders no title element when title is omitted (back-only header)', () => {
    renderWithProviders(<ViewHeader onBack={() => {}} backLabel="Back" />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
