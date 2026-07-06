/**
 * Machine-readable agent-surface index for the extension.
 *
 * One self-describing JSON document an agent can read to learn the entire extension contract
 * without scraping source: the message protocol version + ACTIONS list, the wallet method
 * surface, the catalogued error codes, and the injected window.chia provider surface. It is
 * built from the SAME source modules the runtime imports (messages.mjs / error-codes.mjs /
 * wallet-methods.mjs / dig-provider-core.mjs), so it cannot drift from what actually ships.
 *
 * build.js writes the output to `dist/agent-surface.json` (declared as a
 * web_accessible_resource) and `node build.js --json` prints it to stdout.
 *
 * Plain ES module (no chrome.* / DOM) so it runs in the build and under `node --test`.
 */

import { MESSAGE_PROTOCOL_VERSION, ACTIONS, BRIDGE, MESSAGE_CATALOGUE } from '@/lib/messages';
import { DIG_ERR, ERROR_CATALOGUE } from '@/lib/error-codes';
import { WALLET_METHODS, STATE_CHANGING_METHODS } from '@/lib/wallet-methods';
import { PROVIDER_INFO, PROVIDER_ERROR_CODES, WALLET_PROVIDER_VERSION } from '@/lib/dig-provider-core';

/**
 * Build the agent-surface document.
 * @param {string} version  the extension version (from package.json / the manifest)
 * @returns {object} a JSON-serialisable self-description
 */
export function buildAgentSurface(version?: string) {
  return {
    name: 'dig-chrome-extension',
    version: version || 'unknown',
    schemaVersion: 1,
    messageProtocol: MESSAGE_PROTOCOL_VERSION,
    generatedFrom: 'messages.mjs + error-codes.mjs + wallet-methods.mjs + dig-provider-core.mjs (single source of truth)',
    description:
      'Chromium MV3 extension that resolves chia:// (DIG Network) content client-side and injects a window.chia wallet provider.',

    // The internal chrome.runtime message contract.
    actions: Object.values(ACTIONS),
    messageCatalogue: MESSAGE_CATALOGUE,
    bridge: { ...BRIDGE },

    // The Sage-parity wallet method surface a dapp can call through window.chia.
    walletMethods: [...WALLET_METHODS],
    stateChangingMethods: [...STATE_CHANGING_METHODS],

    // The catalogued chia:// loader error codes (DIG_ERR_*). `canonical` marks the four that
    // are part of the shared cross-surface `dig-loader` subset (docs error-codes.json).
    errorCodes: ERROR_CATALOGUE.map((e) => ({ code: e.code, message: e.message, canonical: e.canonical })),

    // The injected window.chia provider surface.
    provider: {
      providerVersion: WALLET_PROVIDER_VERSION,
      info: { ...PROVIDER_INFO },
      methods: [...WALLET_METHODS],
      discovery: "request({method:'chip0002_getMethods'}) → string[] (answered locally) or window.chia.methods",
      errorCodes: { ...PROVIDER_ERROR_CODES },
    },

    // Cross-surface machine artifacts an agent should follow.
    machineReadable: {
      errorCatalog: 'https://docs.dig.net/error-codes.json',
      errorCatalogSurface: 'dig-loader',
      digRpcSpec: 'https://docs.dig.net/openrpc.json',
      llms: 'https://docs.dig.net/llms.txt',
      // The dig RPC read method this extension calls (note the dig.* namespace on the wire).
      readMethod: 'dig.getContent',
    },

    errorCodeValues: Object.values(DIG_ERR),
  };
}
