import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { DidPanel } from '@/features/identity/DidPanel';
import type { WalletDid } from '@/offscreen/dids';

function did(over: Partial<WalletDid> = {}): WalletDid {
  return {
    launcherId: 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    p2PuzzleHash: 'ef'.repeat(32),
    recoveryListHash: null,
    numVerificationsRequired: '1',
    profileName: null,
    ...over,
  };
}

function mockSw(router: (m: { action: string; [k: string]: unknown }) => unknown) {
  const fn = vi.fn((msg: unknown, cb?: (r: unknown) => void) => {
    const reply = router(msg as { action: string; [k: string]: unknown });
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
  (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('DidPanel', () => {
  it('shows the loading state then the list on success', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [did()] } : { success: true }));
    renderWithProviders(<DidPanel full />);
    expect(await screen.findByTestId('did-list')).toBeInTheDocument();
    expect(screen.getByTestId(`did-tile-${'ab'.repeat(32)}`)).toBeInTheDocument();
  });

  it('shows the empty state when the wallet has no DIDs', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [] } : { success: true }));
    renderWithProviders(<DidPanel full />);
    expect(await screen.findByTestId('identity-empty')).toBeInTheDocument();
  });

  it('shows the error state + retry when the scan fails', async () => {
    mockSw((m) => (m.action === 'listDids' ? { success: false, code: 'CHAIN_UNAVAILABLE' } : { success: true }));
    renderWithProviders(<DidPanel full />);
    expect(await screen.findByTestId('identity-error')).toBeInTheDocument();
  });

  it('exposes "Create DID" and opens the create form on the fullscreen surface (#93)', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [] } : { success: true }));
    renderWithProviders(<DidPanel full />);
    const create = await screen.findByTestId('identity-create');
    expect(create).toBeInTheDocument();
    expect(screen.queryByTestId('identity-create-fullscreen')).not.toBeInTheDocument();
    fireEvent.click(create);
    expect(await screen.findByTestId('did-create-form')).toBeInTheDocument();
  });

  it('offers only an "open full screen" affordance on the popup surface — never the create form (#93)', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [] } : { success: true }));
    renderWithProviders(<DidPanel full={false} />);
    expect(await screen.findByTestId('identity-create-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('identity-create')).not.toBeInTheDocument();
    expect(screen.queryByTestId('did-create-form')).not.toBeInTheDocument();
  });

  it('opens the detail view when a tile is clicked', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [did()] } : { success: true }));
    renderWithProviders(<DidPanel full />);
    fireEvent.click(await screen.findByTestId(`did-tile-${'ab'.repeat(32)}`));
    expect(await screen.findByTestId('did-detail')).toBeInTheDocument();
    // back returns to the list
    fireEvent.click(screen.getByTestId('did-detail-back'));
    expect(await screen.findByTestId('did-list')).toBeInTheDocument();
  });

  it('shows the detail view (read-only) on the popup surface too — never the transfer form', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [did()] } : { success: true }));
    renderWithProviders(<DidPanel full={false} />);
    fireEvent.click(await screen.findByTestId(`did-tile-${'ab'.repeat(32)}`));
    expect(await screen.findByTestId('did-detail')).toBeInTheDocument();
    expect(screen.getByTestId('did-transfer-fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('did-transfer-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('did-transfer-form')).not.toBeInTheDocument();
  });

  it('has no WCAG violations (list)', async () => {
    mockSw((m) => (m.action === 'listDids' ? { dids: [did()] } : { success: true }));
    const { container } = renderWithProviders(<DidPanel full />);
    await screen.findByTestId('did-list');
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
