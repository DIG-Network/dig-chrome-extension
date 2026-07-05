// Type declarations for messages.mjs — the versioned background MESSAGE catalogue.

import type { DigErrorCode } from './error-codes';

/** Version of the message contract (the action set + their request/response shapes). */
export const MESSAGE_PROTOCOL_VERSION: number;

/** Every chrome.runtime `message.action` the background service worker routes. */
export type Action =
  | 'proxyRequest' | 'convertDigUrl' | 'navigateToDigUrl' | 'navigateToDataUrl' | 'getDataUrl'
  | 'navigate' | 'toggleExtension' | 'updateServerConfig' | 'updateRpcHost'
  | 'walletRpc' | 'walletConsent' | 'reportVerification' | 'getVerification'
  | 'getDigNodeStatus' | 'reportError' | 'reportSuccess' | 'addSearchEngine'
  | 'getDefaultSearchEngine' | 'isDigSearchDefault' | 'updateSearchConfig' | 'getCapabilities'
  // Self-custody wallet (#56): keystore ops the SW routes to the offscreen vault.
  | 'createWallet' | 'importWallet' | 'unlockWallet' | 'lockWallet' | 'revealPhrase' | 'getLockState';

export const ACTIONS: Readonly<Record<Action, Action>>;

/** Discriminator on messages the SW forwards to the offscreen keystore vault. */
export const OFFSCREEN_TARGET: 'dig-offscreen';

/** The window.postMessage bridge protocol between the injected provider and the content script. */
export const BRIDGE: Readonly<{ WALLET_REQUEST: 'DIG_WALLET_REQUEST'; WALLET_RESPONSE: 'DIG_WALLET_RESPONSE' }>;

export interface MessageCatalogueEntry {
  summary: string;
  request: string;
  response: string;
}
export const MESSAGE_CATALOGUE: Readonly<Record<Action, MessageCatalogueEntry>>;

export function isKnownAction(action: unknown): action is Action;

/** Machine-readable self-description returned by the `getCapabilities` action. */
export interface Capabilities {
  version: string;
  messageProtocol: number;
  actions: Action[];
  walletMethods: string[];
  stateChangingMethods: string[];
  errorCodes: DigErrorCode[];
  bridge: Record<string, string>;
}
export function buildCapabilities(extensionVersion?: string): Capabilities;
