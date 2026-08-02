import type { ReactNode } from 'react';
import type { PillTone } from '@/lib/pill-tone';

export type { PillTone };

/** A small status pill (activity finality, verification verdict, node state). Tone drives color. */
export function StatusPill({
  tone = 'neutral',
  children,
  testid,
}: {
  tone?: PillTone;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <span className="dig-pill" data-tone={tone} data-testid={testid}>
      {children}
    </span>
  );
}
