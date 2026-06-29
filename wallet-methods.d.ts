// Type declarations for wallet-methods.mjs — the CHIP-0002 / chia_* wallet method surface.

export const CHIP0002_METHODS: readonly string[];
export const CHIA_METHODS: readonly string[];
/** The full Sage-parity method surface a dapp can call through window.chia. */
export const WALLET_METHODS: readonly string[];
/** Methods that mutate on-chain / wallet state (require an explicit per-call wallet approval). */
export const STATE_CHANGING_METHODS: ReadonlySet<string>;

export function normalizeMethod(method: string): string;
export function isSupportedMethod(method: string): boolean;
export function isStateChanging(method: string): boolean;
