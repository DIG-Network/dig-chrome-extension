import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WalletIdenticon } from '@/features/wallet/custody/WalletIdenticon';

describe('WalletIdenticon (#176)', () => {
  it('renders a decorative SVG (hidden from assistive tech — the adjacent label carries identity)', () => {
    const { container } = render(<WalletIdenticon seed="w1" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders at the requested size', () => {
    const { container } = render(<WalletIdenticon seed="w1" size={40} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '40');
    expect(svg).toHaveAttribute('height', '40');
  });

  it('the same seed renders the identical markup twice (deterministic)', () => {
    const a = render(<WalletIdenticon seed="wallet-a" />);
    const b = render(<WalletIdenticon seed="wallet-a" />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
  });

  it('two different seeds render different markup', () => {
    const a = render(<WalletIdenticon seed="wallet-a" />);
    const b = render(<WalletIdenticon seed="wallet-b" />);
    expect(a.container.innerHTML).not.toBe(b.container.innerHTML);
  });

  it('falls back to a default size when none is given', () => {
    const { container } = render(<WalletIdenticon seed="w1" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBeTruthy();
  });
});
