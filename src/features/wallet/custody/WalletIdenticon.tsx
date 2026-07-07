import { identiconFor, IDENTICON_ROWS, IDENTICON_COLS } from '@/features/wallet/custody/identicon';

/**
 * A small deterministic per-wallet avatar (#176) — purely decorative (the adjacent label + address
 * text carry the actual identity for assistive tech, so this is `aria-hidden`, matching the
 * `AssetRow` token-badge convention). `seed` MUST be public data (a cached preview address or the
 * wallet's opaque registry id) — see `identicon.ts` for why this can never touch key material.
 */
export function WalletIdenticon({ seed, size = 28 }: { seed: string; size?: number }) {
  const { hue, cells } = identiconFor(seed);
  const bg = `hsl(${hue}, 70%, 94%)`;
  const fg = `hsl(${hue}, 60%, 46%)`;

  const rects: { key: string; x: number; y: number }[] = [];
  for (let row = 0; row < IDENTICON_ROWS; row++) {
    for (let col = 0; col < IDENTICON_COLS; col++) {
      if (!cells[row * IDENTICON_COLS + col]) continue;
      const mirrorCol = IDENTICON_ROWS - 1 - col;
      rects.push({ key: `${row}-${col}`, x: col, y: row });
      if (mirrorCol !== col) rects.push({ key: `${row}-${mirrorCol}`, x: mirrorCol, y: row });
    }
  }

  return (
    <svg
      className="dig-identicon"
      width={size}
      height={size}
      viewBox={`0 0 ${IDENTICON_ROWS} ${IDENTICON_ROWS}`}
      aria-hidden="true"
      focusable="false"
      style={{ borderRadius: '30%', background: bg, flex: 'none' }}
    >
      {rects.map((r) => (
        <rect key={r.key} x={r.x} y={r.y} width={1} height={1} fill={fg} />
      ))}
    </svg>
  );
}
