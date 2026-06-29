// Type declarations for wallet-broker.mjs — per-origin consent + CHIP-0002 routing.

export const ORIGINS_KEY: 'wallet.origins';
export const CONNECTION_KEY: 'wallet.connection';

/** A chrome.storage.local-like store. */
export interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The WalletConnect → Sage transport injected into the broker. */
export interface WalletTransport {
  isConnected(): Promise<boolean>;
  request(args: { method: string; params?: object }): Promise<unknown>;
}

export interface BrokerDeps {
  storage: StorageLike;
  transport: WalletTransport;
  requestConsent?: (origin: string) => Promise<boolean>;
}

/** The HTTP-like envelope returned to the provider. 200 ok / 202 pending / 4xx-5xx error. */
export interface WalletEnvelope {
  status: number;
  body: { data?: unknown; error?: string };
}

export function getApprovedOrigins(storage: StorageLike): Promise<Record<string, { approved: boolean; ts: number }>>;
export function isOriginApproved(storage: StorageLike, origin: string): Promise<boolean>;
export function setOriginApproval(storage: StorageLike, origin: string, approved: boolean): Promise<Record<string, unknown>>;
export function getConnection(storage: StorageLike): Promise<{ connected: boolean; address?: string; network?: string; topic?: string }>;

export function ok(data: unknown): WalletEnvelope;
export function pending(): WalletEnvelope;
export function err(status: number, message: string): WalletEnvelope;

export function brokerRequest(
  deps: BrokerDeps,
  method: string,
  params: object,
  origin: string
): Promise<WalletEnvelope>;
