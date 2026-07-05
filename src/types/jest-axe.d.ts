/** Minimal declarations for jest-axe (no published @types); used directly (no matcher extend). */
declare module 'jest-axe' {
  export interface AxeViolation {
    id: string;
    impact?: string;
    description: string;
    nodes: unknown[];
  }
  export interface AxeRunResult {
    violations: AxeViolation[];
  }
  export function axe(html: Element | Document | string, options?: unknown): Promise<AxeRunResult>;
}
