// Type declarations for dig-provider-core.mjs — the testable core of the injected
// window.chia provider. The injected dig-provider.js inlines this same surface.

export const WALLET_PROVIDER_VERSION: number;

/** Self-describing capability object exposed as window.chia.info. */
export interface ProviderInfo {
  isDIG: true;
  transport: 'walletconnect' | 'in-process';
  edition: 'extension' | 'browser';
  providerVersion: number;
}
export const PROVIDER_INFO: Readonly<ProviderInfo>;

/** Standard wallet provider error codes (EIP-1193 / CHIP-0002 aligned). */
export const PROVIDER_ERROR_CODES: Readonly<{
  USER_REJECTED: 4001;
  UNAUTHORIZED: 4100;
  UNSUPPORTED_METHOD: 4200;
  DISCONNECTED: 4900;
}>;

/** An Error carrying a standard provider code (and a pending flag for a 202 connect). */
export interface ProviderError extends Error {
  code: number;
  status?: number;
  pending?: boolean;
}

export function mapEnvelopeToError(
  env: { status: number; body?: { error?: string }; error?: string } | null | undefined
): ProviderError;

/** The injected window.chia provider object. */
export interface ChiaProvider {
  isDIG: true;
  isConnected: boolean;
  version: string;
  info: ProviderInfo;
  /** The Sage-parity method catalogue (introspectable without a round-trip). */
  methods: readonly string[];
  request(args: { method: string; params?: object }): Promise<unknown>;
  connect(eager?: boolean): Promise<unknown>;
  on(event: string, fn: (data?: unknown) => void): void;
  off(event: string, fn: (data?: unknown) => void): void;
}

export function buildProvider(deps: {
  bridgeCall: (method: string, params?: object, timeoutMs?: number) => Promise<{ status: number; body?: { data?: unknown; error?: string } }>;
  version?: string;
  emit?: (event: string, data?: unknown) => void;
}): ChiaProvider;
