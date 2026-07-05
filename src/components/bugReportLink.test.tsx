import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { BugReportLink } from '@/components/BugReportLink';

afterEach(() => vi.restoreAllMocks());

describe('BugReportLink (inline bug-report entry)', () => {
  it('renders a quiet inline "Report a bug" item (no floating overlay)', () => {
    renderWithProviders(<BugReportLink />);
    expect(screen.getByTestId('bugreport-inline')).toBeInTheDocument();
    expect(screen.getByTestId('bugreport-inline')).toHaveTextContent('Report a bug');
  });

  it('clicking the inline item looks up + triggers the shared reporter launcher', () => {
    // The shared widget's floating FAB renders only in a real browser (it no-ops in jsdom), so we
    // assert the wiring: the inline item queries for the launcher and clicks it if present (safe no-op
    // when absent — never throws).
    renderWithProviders(<BugReportLink />);
    const fab = document.createElement('button');
    fab.setAttribute('aria-label', 'Report a bug');
    fab.className = 'digbr-launcher';
    document.body.appendChild(fab);
    const spy = vi.spyOn(fab, 'click');
    fireEvent.click(screen.getByTestId('bugreport-inline'));
    expect(spy).toHaveBeenCalled();
    fab.remove();
  });

  it('is a safe no-op when the reporter launcher is not present', () => {
    renderWithProviders(<BugReportLink />);
    expect(() => fireEvent.click(screen.getByTestId('bugreport-inline'))).not.toThrow();
  });
});
