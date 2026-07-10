/**
 * Offscreen keystore vault entry (#56). Runs in the long-lived `chrome.offscreen` document — the
 * SOLE place the decrypted wallet key ever lives (§5.1). It instantiates one {@link Vault} and
 * answers the SW's forwarded requests (`{ target: OFFSCREEN_TARGET, request }`): keystore ops
 * (create/import/unlock/lock/reveal) plus derivation + the coinset balance scan, for which it lazily
 * loads `chia-wallet-sdk-wasm` and builds a per-URL chain client (both live only here, at runtime);
 * the vault CRYPTO itself (dig_ecosystem #147 Phase B) lazily loads `@dignetwork/dig-keystore-wasm`
 * the same way. Thin glue only — the crypto/scan logic + tests live in `src/offscreen/*`; this file
 * is coverage-excluded (src/entries/**).
 */
import { OFFSCREEN_TARGET } from '@/lib/messages';
import { Vault, type VaultRequest, type VaultResponse, type VaultDeps } from '@/offscreen/vault';
import { loadChiaWasm } from '@/lib/keystore/derive';
import type { KeystoreWasm } from '@/lib/keystore/digwx1';
import { makeWasmChainClient, DEFAULT_COINSET_URL, type ChainClient, type RpcCapableWasm } from '@/offscreen/chain';
import type { ScanWasm } from '@/offscreen/scan';
// #228: the DataLayer store-coin driver wasm + the plain-fetch coinset client for the
// coinset-direct chain-anchored-root walk (hosted rpc.dig.net tier fallback for a rootless read).
import { makeFetchLineageClient, type Chip35Wasm, type LineageCoinsetClient } from '@/offscreen/anchoredRoot';

/** The wasm as used in the offscreen document: derivation + CAT + coinset RpcClient. */
type OffscreenWasm = ScanWasm & RpcCapableWasm;

const vault = new Vault();
let chiaPromise: Promise<OffscreenWasm> | null = null;
let keystoreWasmPromise: Promise<KeystoreWasm> | null = null;
let chip35Promise: Promise<Chip35Wasm> | null = null;
const chainByUrl = new Map<string, ChainClient>();
const lineageClientByUrl = new Map<string, LineageCoinsetClient>();

function getChia(): Promise<OffscreenWasm> {
  if (!chiaPromise) chiaPromise = loadChiaWasm() as unknown as Promise<OffscreenWasm>;
  return chiaPromise;
}

/* c8 ignore start -- real wasm module load, exercised by the real-browser Playwright e2e, not jsdom */
/** Lazily import the real `@dignetwork/dig-keystore-wasm` (offscreen-document runtime only). */
function getKeystoreWasm(): Promise<KeystoreWasm> {
  if (!keystoreWasmPromise) {
    keystoreWasmPromise = import('@dignetwork/dig-keystore-wasm') as unknown as Promise<KeystoreWasm>;
  }
  return keystoreWasmPromise;
}
/** Lazily import the real `@dignetwork/chip35-dl-coin-wasm` (#228, offscreen-document runtime
 *  only — the DataLayer store-coin driver, for the coinset chain-anchored-root walk). */
function getChip35(): Promise<Chip35Wasm> {
  if (!chip35Promise) chip35Promise = import('@dignetwork/chip35-dl-coin-wasm') as unknown as Promise<Chip35Wasm>;
  return chip35Promise;
}
/* c8 ignore stop */

const NEEDS_CHIA = new Set<VaultRequest['op']>(['getReceiveAddress', 'scanBalances', 'prepareSend', 'confirmSend', 'sendStatus', 'makeOffer', 'inspectOffer', 'prepareTrade', 'confirmTrade', 'listNfts', 'prepareNftTransfer', 'prepareNftMint', 'listDids', 'prepareDidCreate', 'prepareDidTransfer', 'prepareDidProfileUpdate', 'prepareNftDidAssign', 'listCoins', 'prepareSplit', 'prepareCombine', 'listClawbacks', 'prepareClawbackAction', 'getPublicKeys', 'getAssetBalance', 'getAssetCoins', 'decodeDappSpend', 'signDappSpend', 'signMessage', 'broadcastDappBundle']);
const NEEDS_CHAIN = new Set<VaultRequest['op']>(['scanBalances', 'prepareSend', 'confirmSend', 'sendStatus', 'makeOffer', 'prepareTrade', 'confirmTrade', 'listNfts', 'prepareNftTransfer', 'prepareNftMint', 'listDids', 'prepareDidCreate', 'prepareDidTransfer', 'prepareDidProfileUpdate', 'prepareNftDidAssign', 'listCoins', 'prepareSplit', 'prepareCombine', 'listClawbacks', 'prepareClawbackAction', 'getAssetBalance', 'getAssetCoins', 'broadcastDappBundle']);
/** Ops whose crypto goes through `digwx1.ts` (create/import write a V2 record; unlock/reveal/export
 * decrypt EITHER version) — dig_ecosystem #147 Phase B. */
const NEEDS_KEYSTORE_WASM = new Set<VaultRequest['op']>(['createWallet', 'importWallet', 'unlockWallet', 'revealPhrase', 'exportPrivateKey']);
/** #228: the coinset-direct chain-anchored-root walk — independent of NEEDS_CHIA/NEEDS_CHAIN (it
 * needs neither chia-wallet-sdk-wasm nor its wasm RpcClient; see anchoredRoot.ts's doc comment). */
const NEEDS_CHIP35 = new Set<VaultRequest['op']>(['resolveCoinsetAnchoredRoot']);

async function depsFor(req: VaultRequest & { coinsetUrl?: string }): Promise<VaultDeps> {
  const deps: VaultDeps = {};
  if (NEEDS_KEYSTORE_WASM.has(req.op)) deps.keystoreWasm = await getKeystoreWasm();
  if (NEEDS_CHIP35.has(req.op)) {
    deps.chip35 = await getChip35();
    const lineageUrl = req.coinsetUrl || DEFAULT_COINSET_URL;
    let lineageClient = lineageClientByUrl.get(lineageUrl);
    if (!lineageClient) {
      lineageClient = makeFetchLineageClient(lineageUrl);
      lineageClientByUrl.set(lineageUrl, lineageClient);
    }
    deps.lineageClient = lineageClient;
  }
  if (!NEEDS_CHIA.has(req.op)) return deps;
  const chia = await getChia();
  deps.chia = chia;
  if (!NEEDS_CHAIN.has(req.op)) return deps;
  const url = req.coinsetUrl || DEFAULT_COINSET_URL;
  let chain = chainByUrl.get(url);
  if (!chain) {
    chain = makeWasmChainClient(chia, url);
    chainByUrl.set(url, chain);
  }
  deps.chain = chain;
  return deps;
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
