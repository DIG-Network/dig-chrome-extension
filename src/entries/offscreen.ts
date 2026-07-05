/**
 * Offscreen keystore vault entry (#56). Runs in the long-lived `chrome.offscreen` document — the
 * SOLE place the decrypted wallet key ever lives (§5.1). It instantiates one {@link Vault} and
 * answers the SW's forwarded requests (`{ target: OFFSCREEN_TARGET, request }`): keystore ops
 * (create/import/unlock/lock/reveal) plus derivation + the coinset balance scan, for which it lazily
 * loads `chia-wallet-sdk-wasm` and builds a per-URL chain client (both live only here, at runtime).
 * Thin glue only — the crypto/scan logic + tests live in `src/offscreen/*`; this file is
 * coverage-excluded (src/entries/**).
 */
import { OFFSCREEN_TARGET } from '#shared/messages.mjs';
import { Vault, type VaultRequest, type VaultResponse, type VaultDeps } from '@/offscreen/vault';
import { loadChiaWasm } from '@/lib/keystore/derive';
import { makeWasmChainClient, DEFAULT_COINSET_URL, type ChainClient, type RpcCapableWasm } from '@/offscreen/chain';
import type { ScanWasm } from '@/offscreen/scan';

/** The wasm as used in the offscreen document: derivation + CAT + coinset RpcClient. */
type OffscreenWasm = ScanWasm & RpcCapableWasm;

const vault = new Vault();
let chiaPromise: Promise<OffscreenWasm> | null = null;
const chainByUrl = new Map<string, ChainClient>();

function getChia(): Promise<OffscreenWasm> {
  if (!chiaPromise) chiaPromise = loadChiaWasm() as unknown as Promise<OffscreenWasm>;
  return chiaPromise;
}

const NEEDS_CHIA = new Set<VaultRequest['op']>(['getReceiveAddress', 'scanBalances', 'prepareSend', 'confirmSend', 'sendStatus', 'getActivity', 'makeOffer', 'inspectOffer', 'prepareTrade', 'confirmTrade']);
const NEEDS_CHAIN = new Set<VaultRequest['op']>(['scanBalances', 'prepareSend', 'confirmSend', 'sendStatus', 'getActivity', 'makeOffer', 'prepareTrade', 'confirmTrade']);

async function depsFor(req: VaultRequest & { coinsetUrl?: string }): Promise<VaultDeps> {
  if (!NEEDS_CHIA.has(req.op)) return {};
  const chia = await getChia();
  if (!NEEDS_CHAIN.has(req.op)) return { chia };
  const url = req.coinsetUrl || DEFAULT_COINSET_URL;
  let chain = chainByUrl.get(url);
  if (!chain) {
    chain = makeWasmChainClient(chia, url);
    chainByUrl.set(url, chain);
  }
  return { chia, chain };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { target?: string; request?: VaultRequest & { coinsetUrl?: string } } | null;
  if (!msg || msg.target !== OFFSCREEN_TARGET || !msg.request) return; // not for the vault
  const req = msg.request;
  depsFor(req)
    .then((deps) => vault.handle(req, deps))
    .then((res: VaultResponse) => sendResponse(res))
    .catch(() => sendResponse({ success: false, code: 'VAULT_ERROR', message: 'vault crashed' }));
  return true; // keep the message channel open for the async reply
});
