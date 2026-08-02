import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExternalLink } from '@/components/ExternalLink';
import { renderWithProviders } from '@/test/harness';

describe('ExternalLink', () => {
  it('opens the url in a new tab via chrome.tabs', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 1 }));
    chrome.tabs.create = create as never;
    renderWithProviders(
      <ExternalLink href="https://dig.net" testid="ext">
        link
      </ExternalLink>,
    );
    await userEvent.click(screen.getByTestId('ext'));
    expect(create).toHaveBeenCalledWith({ url: 'https://dig.net' });
  });
});
