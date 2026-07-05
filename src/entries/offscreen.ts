/**
 * Offscreen keystore vault entry (#56). Runs in the long-lived `chrome.offscreen` document — the
 * SOLE place the decrypted wallet key ever lives (§5.1). It instantiates one {@link Vault} and
 * answers the SW's forwarded custody requests (`{ target: OFFSCREEN_TARGET, request: VaultRequest }`).
 * Thin glue only (no branches worth covering) — the crypto/lifecycle logic + its tests live in
 * `src/offscreen/vault.ts`; this file is coverage-excluded (src/entries/**).
 */
import { OFFSCREEN_TARGET } from '#shared/messages.mjs';
import { Vault, type VaultRequest, type VaultResponse } from '@/offscreen/vault';

const vault = new Vault();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { target?: string; request?: VaultRequest } | null;
  if (!msg || msg.target !== OFFSCREEN_TARGET || !msg.request) return; // not for the vault
  vault
    .handle(msg.request)
    .then((res: VaultResponse) => sendResponse(res))
    .catch(() => sendResponse({ success: false, code: 'VAULT_ERROR', message: 'vault crashed' }));
  return true; // keep the message channel open for the async reply
});
