import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { renderWithProviders } from '@/test/harness';
import { ConsolidateModal, type ConsolidateModalState } from './ConsolidateModal';

const promptState: ConsolidateModalState = {
  open: true,
  phase: 'prompting',
  quote: { asset: 'XCH', coinsMerged: 42, fee: '1000000000' }, // 0.001 XCH
};

describe('ConsolidateModal (#417)', () => {
  it('renders nothing when closed', () => {
    renderWithProviders(<ConsolidateModal state={{ open: false, phase: 'idle', quote: null }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('consolidate-modal')).toBeNull();
  });

  it('renders nothing when open but idle', () => {
    renderWithProviders(<ConsolidateModal state={{ open: true, phase: 'idle', quote: null }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('consolidate-modal')).toBeNull();
  });

  it('shows the honest prompt: coins-merged count, fee, and both actions', () => {
    renderWithProviders(<ConsolidateModal state={promptState} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('consolidate-prompt')).toBeTruthy();
    // The count is woven into the honest body copy; the fee is shown in XCH.
    expect(screen.getByText(/42/)).toBeTruthy();
    expect(screen.getByTestId('consolidate-fee').textContent).toContain('0.001');
    expect(screen.getByTestId('consolidate-confirm')).toBeTruthy();
    expect(screen.getByTestId('consolidate-cancel')).toBeTruthy();
  });

  it('wires the primary button to onConfirm and the secondary to onCancel (dismissible)', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithProviders(<ConsolidateModal state={promptState} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('consolidate-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('consolidate-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cancels on Escape while prompting (honest, no dark pattern)', () => {
    const onCancel = vi.fn();
    renderWithProviders(<ConsolidateModal state={promptState} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows a live-region progress state (no action buttons) while the combine is in flight', () => {
    renderWithProviders(
      <ConsolidateModal state={{ open: true, phase: 'confirming', quote: promptState.quote }} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const progress = screen.getByTestId('consolidate-progress');
    expect(progress.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByTestId('consolidate-confirm')).toBeNull();
  });

  it('has no axe violations in the prompt state', async () => {
    renderWithProviders(<ConsolidateModal state={promptState} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    // The dialog is portaled to document.body; scan the whole body. jsdom can't compute contrast.
    const results = await axe(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
