import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { AppsTab } from '@/features/apps/AppsTab';
import { renderWithProviders } from '@/test/harness';

afterEach(() => {
  vi.useRealTimers();
});

describe('AppsTab', () => {
  it('starts loading and embeds the explore.dig.net /apps iframe', () => {
    renderWithProviders(<AppsTab />);
    expect(screen.getByTestId('apps-loading')).toBeInTheDocument();
    expect(screen.getByTestId('apps-frame').getAttribute('src')).toBe('https://explore.dig.net/apps');
  });

  it('goes ready when the iframe loads', () => {
    renderWithProviders(<AppsTab />);
    fireEvent.load(screen.getByTestId('apps-frame'));
    expect(screen.queryByTestId('apps-loading')).not.toBeInTheDocument();
  });

  it('shows the error + retry state after the load timeout', () => {
    vi.useFakeTimers();
    renderWithProviders(<AppsTab />);
    act(() => {
      vi.advanceTimersByTime(13000);
    });
    expect(screen.getByTestId('apps-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('apps-retry'));
    expect(screen.getByTestId('apps-loading')).toBeInTheDocument();
  });
});
