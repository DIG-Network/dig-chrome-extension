import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { createStore } from '@/app/store';
import { NetworkScreen } from '@/features/network/NetworkScreen';

beforeEach(() => {
  (chrome as unknown as { storage: unknown }).storage = { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } };
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn((_m: unknown, cb?: (r: unknown) => void) => {
    const reply = { success: true, reachable: false, base: null };
    if (cb) cb(reply);
    return Promise.resolve(reply);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('NetworkScreen (groups resolver/shield/control)', () => {
  it('defaults to the resolver sub-view and switches via the segmented control', async () => {
    const store = createStore();
    renderWithProviders(<NetworkScreen />, { store });
    expect(screen.getByTestId('network-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('resolver-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('seg-shield'));
    expect(await screen.findByTestId('shield-panel')).toBeInTheDocument();
    expect(store.getState().ui.networkView).toBe('shield');

    fireEvent.click(screen.getByTestId('seg-control'));
    expect(await screen.findByTestId('control-panel')).toBeInTheDocument();
    expect(store.getState().ui.networkView).toBe('control');
  });
});
