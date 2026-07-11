import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleSwitch } from '@/components/ToggleSwitch';

describe('ToggleSwitch (#306 — a real switch, not a checkbox)', () => {
  it('renders as role="switch" with aria-checked reflecting state (accessible, not a checkbox)', () => {
    render(<ToggleSwitch checked={false} onChange={() => {}} label="DIG toolbar" testid="sw" />);
    const sw = screen.getByRole('switch', { name: 'DIG toolbar' });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('data-checked', 'false');
  });

  it('shows aria-checked=true when on', () => {
    render(<ToggleSwitch checked onChange={() => {}} label="DIG toolbar" testid="sw" />);
    expect(screen.getByTestId('sw')).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange with the toggled value on click', async () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="DIG toolbar" testid="sw" />);
    await userEvent.click(screen.getByTestId('sw'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles from on to off', async () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked onChange={onChange} label="DIG toolbar" testid="sw" />);
    await userEvent.click(screen.getByTestId('sw'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not fire onChange when disabled', async () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="DIG toolbar" testid="sw" disabled />);
    await userEvent.click(screen.getByTestId('sw'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
