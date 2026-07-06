/**
 * The offscreen keystore VAULT — the in-memory custody core that runs ONLY inside the long-lived
 * `chrome.offscreen` document (§5.1). It is the sole place the decrypted wallet secret ever lives:
 * `unlockWallet` decrypts the DIGWX1 blob and holds the BIP-39 entropy in this object's memory;
 * `lockWallet` zeroizes it. The service worker coordinates + owns storage, but never sees the key —
 * it forwards `VaultRequest`s here and gets back only public results (lock state, the encrypted
 * record to persist, or the once-shown mnemonic).
 *
 * This class is PURE (WebCrypto + hash-wasm + @scure/bip39 via the tested `lib/keystore` modules;
 * no chrome.* / DOM), so it is unit-tested in Vitest with a fast injected Argon2. `src/offscreen/
 * main.ts` is the thin runtime glue that instantiates it and wires `chrome.runtime.onMessage`.
 *
 * Zeroization is best-effort in JS (§5.9): the held entropy is `fill(0)`-ed and dropped on lock,
 * and transient copies (e.g. the reveal buffer) are wiped immediately. JS cannot guarantee erasure.
 */

import {
  encryptEntropy,
  decryptEntropy,
  ARGON2_DEFAULT,
  ARGON2_STRONG,
  KeystoreError,
  type Digwx1Record,
  type Argon2Fn,
} from '@/lib/keystore/digwx1';
import {
  generateMnemonic,
  isValidMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
  mnemonicToSeed,
} from '@/lib/keystore/bip39';
import { scanBalances, receiveAddress, DEFAULT_GAP_LIMIT, type ScanWasm, type BalanceScan } from '@/offscreen/scan';
import { deriveAccounts } from '@/lib/keystore/derive';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';
import { prepareXchSend, prepareCatSend, signAndBundle, buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import { listNfts, prepareNftTransfer, type NftWasm, type WalletNft, type NftTransferSummary } from '@/offscreen/nfts';
import { MAINNET_AGG_SIG_ME, type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import { decodeDappSpend, reconstructCoinSpends, signDappCoinSpends, signMessageCustody, type DappSignWasm, type DappSpendSummary, type WireCoinSpend } from '@/offscreen/dappSign';
import { indexActivity, type ActivityWasm, type ActivityEvent } from '@/offscreen/activity';
import { makeOffer, inspectOffer, takeOffer, cancelOffer, type OfferWasm, type OfferAsset, type OfferLeg, type OfferSummary } from '@/offscreen/offers';
import type { ChainSpendBundle } from '@/offscreen/chain';

/**
 * A CHIP-0002 `getAssetBalance` result: the wallet-wide aggregate for one asset (XCH or a CAT), in
 * base units as decimal strings. `confirmed === spendable` — the self-custody wallet does not hold
 * coins reserved across dApp calls, so every unspent coin is spendable — and `spendableCoinCount` is
 * how many coins back it.
 */
export interface WireAssetBalance {
  confirmed: string;
  spendable: string;
  spendableCoinCount: number;
}
/**
 * A CHIP-0002 `getAssetCoins` spendable coin: the coin's identity (camelCase, Goby-parity) + its coin
 * name (id, hex) + `locked:false`. A dApp uses this to select coins before building a spend it then
 * hands back to `signCoinSpends`.
 */
export interface WireSpendableCoin {
  coin: { parentCoinInfo: string; puzzleHash: string; amount: string };
  coinName: string;
  locked: boolean;
}

/** Wire-safe (JSON, no bigint) asset descriptor crossing the SW boundary. */
export type WireOfferAsset = { kind: 'xch' } | { kind: 'cat'; assetId: string };
/** Wire-safe trade leg: asset + amount as a decimal string (base units). */
export interface WireOfferLeg {
  asset: WireOfferAsset;
  amount: string;
}
/** Wire-safe two-sided offer summary (base-unit amounts as strings). */
export interface WireOfferSummary {
  offered: WireOfferLeg[];
  requested: { asset: WireOfferAsset; amount: string; toPuzzleHashHex: string }[];
}

const toLeg = (w: WireOfferLeg): OfferLeg => ({ asset: w.asset as OfferAsset, amount: BigInt(w.amount) });
const toWireSummary = (s: OfferSummary): WireOfferSummary => ({
  offered: s.offered.map((l) => ({ asset: l.asset, amount: l.amount.toString() })),
  requested: s.requested.map((r) => ({ asset: r.asset, amount: r.amount.toString(), toPuzzleHashHex: r.toPuzzleHashHex })),
});

/** The keystore operations the vault handles (mirrors the SW custody actions). */
export type VaultOp =
  | 'createWallet'
  | 'importWallet'
  | 'unlockWallet'
  | 'lockWallet'
  | 'revealPhrase'
  | 'getVaultState'
  | 'getReceiveAddress'
  | 'scanBalances'
  | 'prepareSend'
  | 'confirmSend'
  | 'sendStatus'
  | 'getActivity'
  | 'makeOffer'
  | 'inspectOffer'
  | 'prepareTrade'
  | 'confirmTrade'
  | 'listNfts'
  | 'prepareNftTransfer'
  // dApp `window.chia` RPC (§5.5): identity read + approval-gated foreign-spend / message signing.
  | 'getPublicKeys'
  | 'getAssetBalance'
  | 'getAssetCoins'
  | 'decodeDappSpend'
  | 'signDappSpend'
  | 'signMessage'
  | 'broadcastDappBundle';

/** A request forwarded from the SW to the vault. `record` is the persisted DIGWX1 blob for ops that need it. */
export interface VaultRequest {
  op: VaultOp;
  password?: string;
  mnemonic?: string;
  label?: string;
  /** Use the STRONG (256 MiB) Argon2 preset for a high-value wallet. */
  strong?: boolean;
  /** The persisted keystore record (SW reads it from storage for unlock / reveal). */
  record?: Digwx1Record;
  /** Watched CAT asset ids (TAILs) to scan for balances. */
  watchedCats?: string[];
  /** HD scan gap limit per scheme. */
  gapLimit?: number;
  /** Send: recipient bech32m address. */
  recipient?: string;
  /** Send: amount + fee in base units (mojos), as decimal strings. */
  amount?: string;
  fee?: string;
  /** Send: a CAT asset id (TAIL hex) for a token send; omitted/`'xch'` = native XCH. */
  assetId?: string;
  /** confirmSend/sendStatus: the pending-send id / an input coin id (hex). */
  pendingId?: string;
  coinId?: string;
  /** getActivity: resume the incremental scan from this block height. */
  sinceHeight?: number;
  /** makeOffer: the leg the wallet gives / the leg it wants (wire-safe, string amounts). */
  offered?: WireOfferLeg;
  requested?: WireOfferLeg;
  /** inspectOffer / prepareTrade: the `offer1…` string. */
  offerStr?: string;
  /** prepareTrade: whether to TAKE (fund + accept) or CANCEL (reclaim) the offer. */
  tradeKind?: 'take' | 'cancel';
  /** prepareNftTransfer: the NFT's singleton launcher id (hex). */
  launcherId?: string;
  /** decodeDappSpend / signDappSpend: the dApp-supplied coin spends (CHIP-0002 wire, hex fields). */
  coinSpends?: WireCoinSpend[];
  /** signMessage: the UTF-8 message a dApp asked the wallet to sign. */
  message?: string;
  /** signMessage: an optional requested public key (hex); the wallet MUST own it or fails MISSING_KEY. */
  publicKey?: string;
  /** broadcastDappBundle: the dApp bundle's aggregated BLS signature (hex) — the bundle is already signed. */
  aggregatedSignature?: string;
}

/** The vault's reply. Never carries the persisted key; `mnemonic` is for one-time display only. */
export interface VaultResponse {
  success: boolean;
  /** Machine code on failure (`UNLOCK_FAILED`, `INVALID_MNEMONIC`, `BAD_REQUEST`). */
  code?: string;
  message?: string;
  /** Whether the vault currently holds a decrypted key. */
  hasKey?: boolean;
  /** True when the PBKDF2 fallback engaged (caller warns + schedules re-encryption). */
  usedFallback?: boolean;
  /** The encrypted record to persist (create / import only). */
  record?: Digwx1Record;
  /** The 24-word phrase — create + reveal only; shown once, never stored. */
  mnemonic?: string;
  /** The pooled receive address (getReceiveAddress). */
  address?: string;
  /** The scanned balances (scanBalances). */
  balances?: BalanceScan;
  /** prepareSend: the pending id + the decoded (tamper-resistant) summary to approve. */
  pendingId?: string;
  summary?: { asset: string; sent: string; change: string; fee: string; recipientPuzzleHashHex: string; coinCount: number };
  /** confirmSend: an input coin id (hex) to poll for confirmation. */
  spentCoinId?: string;
  /** sendStatus: whether the spend has confirmed on-chain. */
  confirmed?: boolean;
  /** getActivity: the reconstructed ledger events + the height cursor for the next incremental scan. */
  events?: ActivityEvent[];
  cursorHeight?: number;
  /** makeOffer: the shareable `offer1…` string. */
  offer?: string;
  /** makeOffer / inspectOffer / prepareTrade: the decoded two-sided summary. */
  offerSummary?: WireOfferSummary;
  /** listNfts: the wallet's NFTs (both HD schemes), wire-safe. */
  nfts?: WalletNft[];
  /** prepareNftTransfer: the decoded transfer summary to approve. */
  nftSummary?: NftTransferSummary;
  /** getPublicKeys: the wallet's synthetic public keys (hex, both HD schemes, deduped). */
  publicKeys?: string[];
  /** getAssetBalance: the wallet-wide aggregate for the requested asset (XCH or a CAT). */
  assetBalance?: WireAssetBalance;
  /** getAssetCoins: the wallet's spendable coins for the requested asset. */
  assetCoins?: WireSpendableCoin[];
  /** decodeDappSpend: the tamper-resistant summary decoded from the dApp-supplied coin spends. */
  dappSummary?: DappSpendSummary;
  /** signDappSpend: the aggregated BLS signature (hex); signMessage: the message signature (hex). */
  signature?: string;
  /** signMessage: the public key (hex) the message was signed under. */
  signerPublicKey?: string;
}

/** Test/DI seam. `chia` + `chain` power derivation + the balance scan (offscreen-only at runtime). */
export interface VaultDeps {
  argon2Fn?: Argon2Fn;
  chia?: ScanWasm;
  chain?: ChainClient;
}

/** A prepared-but-unsigned send held between approval and confirm (offscreen memory only). */
interface PendingSend {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  inputCoinIds: string[];
}

export class Vault {
  /** The decrypted BIP-39 entropy — the ONLY secret held, in memory only. */
  private entropy: Uint8Array | null = null;

  /** Prepared sends awaiting user approval → confirm (cleared on confirm / lock). */
  private pending = new Map<string, PendingSend>();

  /** Prepared trades (take/cancel) — a signed bundle held between approval and broadcast. */
  private pendingTrades = new Map<string, { bundle: ChainSpendBundle; inputCoinId: string }>();

  /** True iff a decrypted key is currently held in memory. */
  hasKey(): boolean {
    return this.entropy !== null;
  }

  /** Zeroize + drop the held secret (best-effort). Idempotent. Also drops any pending sends. */
  lock(): void {
    if (this.entropy) this.entropy.fill(0);
    this.entropy = null;
    this.pending.clear();
    this.pendingTrades.clear();
  }

  /** Replace the held entropy, zeroizing any prior copy first. */
  private hold(entropy: Uint8Array): void {
    this.lock();
    this.entropy = entropy;
  }

  /** Dispatch one vault request. Never throws — failures come back as `{success:false, code}`. */
  async handle(req: VaultRequest, deps: VaultDeps = {}): Promise<VaultResponse> {
    try {
      switch (req.op) {
        case 'createWallet':
          return await this.createWallet(req, deps);
        case 'importWallet':
          return await this.importWallet(req, deps);
        case 'unlockWallet':
          return await this.unlockWallet(req, deps);
        case 'revealPhrase':
          return await this.revealPhrase(req, deps);
        case 'lockWallet':
          this.lock();
          return { success: true, hasKey: false };
        case 'getVaultState':
          return { success: true, hasKey: this.hasKey() };
        case 'getReceiveAddress':
          return await this.getReceiveAddress(deps);
        case 'scanBalances':
          return await this.scanBalances(req, deps);
        case 'prepareSend':
          return await this.prepareSend(req, deps);
        case 'confirmSend':
          return await this.confirmSend(req, deps);
        case 'sendStatus':
          return await this.sendStatus(req, deps);
        case 'getActivity':
          return await this.getActivity(req, deps);
        case 'makeOffer':
          return await this.makeOffer(req, deps);
        case 'inspectOffer':
          return await this.inspectOffer(req, deps);
        case 'prepareTrade':
          return await this.prepareTrade(req, deps);
        case 'confirmTrade':
          return await this.confirmTrade(req, deps);
        case 'listNfts':
          return await this.listNfts(req, deps);
        case 'prepareNftTransfer':
          return await this.prepareNftTransfer(req, deps);
        case 'getPublicKeys':
          return await this.getPublicKeys(req, deps);
        case 'getAssetBalance':
          return await this.getAssetBalance(req, deps);
        case 'getAssetCoins':
          return await this.getAssetCoins(req, deps);
        case 'decodeDappSpend':
          return await this.decodeDappSpend(req, deps);
        case 'signDappSpend':
          return await this.signDappSpend(req, deps);
        case 'signMessage':
          return await this.signMessage(req, deps);
        case 'broadcastDappBundle':
          return await this.broadcastDappBundle(req, deps);
        default:
          return { success: false, code: 'BAD_REQUEST', message: `unknown vault op` };
      }
    } catch (e) {
      // Never leak internals; map keystore errors to their code, everything else to a generic code.
      if (e instanceof KeystoreError) return { success: false, code: e.code, message: e.message };
      return { success: false, code: 'VAULT_ERROR', message: 'vault operation failed' };
    }
  }

  private async createWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password) return { success: false, code: 'BAD_REQUEST', message: 'password required' };
    const mnemonic = generateMnemonic();
    const entropy = mnemonicToEntropy(mnemonic);
    const { record, usedFallback } = await encryptEntropy(entropy, req.password, {
      argon2Params: req.strong ? ARGON2_STRONG : ARGON2_DEFAULT,
      ...(req.label ? { label: req.label } : {}),
      ...(deps.argon2Fn ? { argon2Fn: deps.argon2Fn } : {}),
    });
    this.hold(entropy);
    return { success: true, hasKey: true, record, mnemonic, usedFallback };
  }

  private async importWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password) return { success: false, code: 'BAD_REQUEST', message: 'password required' };
    if (!req.mnemonic || !isValidMnemonic(req.mnemonic)) {
      return { success: false, code: 'INVALID_MNEMONIC', message: 'recovery phrase is invalid' };
    }
    const entropy = mnemonicToEntropy(req.mnemonic);
    const { record, usedFallback } = await encryptEntropy(entropy, req.password, {
      argon2Params: req.strong ? ARGON2_STRONG : ARGON2_DEFAULT,
      ...(req.label ? { label: req.label } : {}),
      ...(deps.argon2Fn ? { argon2Fn: deps.argon2Fn } : {}),
    });
    this.hold(entropy);
    return { success: true, hasKey: true, record, usedFallback };
  }

  private async unlockWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password || !req.record) {
      return { success: false, code: 'BAD_REQUEST', message: 'password and record required' };
    }
    const entropy = await decryptEntropy(req.record, req.password, deps.argon2Fn);
    this.hold(entropy);
    return { success: true, hasKey: true };
  }

  /**
   * Reveal the recovery phrase for backup — re-runs the FULL password decrypt (§5.5: never from the
   * TTL window). Does not alter the held-key state; the transient entropy copy is zeroized.
   */
  private async revealPhrase(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password || !req.record) {
      return { success: false, code: 'BAD_REQUEST', message: 'password and record required' };
    }
    const entropy = await decryptEntropy(req.record, req.password, deps.argon2Fn);
    const mnemonic = entropyToMnemonic(entropy);
    entropy.fill(0);
    return { success: true, mnemonic };
  }

  /** Derive the held wallet's BIP-39 seed from the in-memory entropy (never leaves the vault). */
  private async heldSeed(): Promise<Uint8Array | null> {
    if (!this.entropy) return null;
    return mnemonicToSeed(entropyToMnemonic(this.entropy));
  }

  private async getReceiveAddress(deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'derivation unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    return { success: true, address: receiveAddress(deps.chia, seed) };
  }

  private async scanBalances(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const balances = await scanBalances(deps.chia, deps.chain, {
      seed,
      ...(req.watchedCats ? { watchedCats: req.watchedCats } : {}),
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
    });
    return { success: true, balances };
  }

  /**
   * Prepare (build, don't sign/broadcast) an XCH send and HOLD it under a pending id. Returns the
   * decoded summary derived from the built spend for the user to approve. `chia` is the full wasm.
   */
  private async prepareSend(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.recipient || req.amount == null) return { success: false, code: 'BAD_REQUEST', message: 'recipient + amount required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as SendFlowWasm;
    const isCat = !!req.assetId && req.assetId.toLowerCase() !== 'xch';
    const prepared = isCat
      ? await prepareCatSend(chia, deps.chain, {
          seed,
          assetId: req.assetId as string,
          recipient: req.recipient,
          amount: BigInt(req.amount),
          fee: BigInt(req.fee ?? '0'),
          ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
        })
      : await prepareXchSend(chia, deps.chain, {
          seed,
          recipient: req.recipient,
          amount: BigInt(req.amount),
          fee: BigInt(req.fee ?? '0'),
          ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
        });
    const pendingId = crypto.randomUUID();
    const inputCoinIds = prepared.coinSpends.map((cs) => chia.toHex(cs.coin.coinId()).replace(/^0x/i, '').toLowerCase());
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds });
    return { success: true, pendingId, summary: prepared.summary };
  }

  /**
   * Sign + broadcast a previously-prepared send (the APPROVED step — the only place a real spend is
   * pushed). Consumes the pending entry; returns an input coin id to poll for confirmation.
   */
  private async confirmSend(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const held = req.pendingId ? this.pending.get(req.pendingId) : undefined;
    if (!held) return { success: false, code: 'NO_PENDING', message: 'no matching pending send' };
    const chia = deps.chia as unknown as SendFlowWasm;
    const bundle = signAndBundle(chia, held.coinSpends, held.secretKeys, MAINNET_AGG_SIG_ME);
    const push = await deps.chain.pushSpendBundle(bundle);
    this.pending.delete(req.pendingId!);
    if (!push.success) return { success: false, code: 'PUSH_FAILED', message: push.error ?? 'broadcast failed' };
    return { success: true, spentCoinId: held.inputCoinIds[0] };
  }

  /** Poll whether a broadcast send has confirmed (an input coin is now recorded spent). */
  private async sendStatus(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.coinId) return { success: false, code: 'BAD_REQUEST', message: 'coinId required' };
    return { success: true, confirmed: await deps.chain.coinConfirmed(req.coinId) };
  }

  /** Reconstruct the transaction ledger (read-only) from `sinceHeight` for an incremental scan. */
  private async getActivity(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const idx = await indexActivity(deps.chia as unknown as ActivityWasm, deps.chain, {
      seed,
      ...(req.watchedCats ? { watchedCats: req.watchedCats } : {}),
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
      ...(req.sinceHeight ? { sinceHeight: req.sinceHeight } : {}),
    });
    return { success: true, events: idx.events, cursorHeight: idx.cursorHeight };
  }

  /** MAKE a trade offer (build + encode; does NOT broadcast). Returns the shareable string + summary. */
  private async makeOffer(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.offered || !req.requested) return { success: false, code: 'BAD_REQUEST', message: 'offered + requested required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const made = await makeOffer(deps.chia as unknown as OfferWasm, deps.chain, {
      seed,
      offered: toLeg(req.offered),
      requested: toLeg(req.requested),
      ...(req.fee ? { fee: BigInt(req.fee) } : {}),
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
    });
    return { success: true, offer: made.offer, offerSummary: toWireSummary(made.summary) };
  }

  /** INSPECT an offer (decode + two-sided summary). Read-only; needs the wasm but no held key. */
  private async inspectOffer(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'decode unavailable' };
    if (!req.offerStr) return { success: false, code: 'BAD_REQUEST', message: 'offerStr required' };
    const summary = inspectOffer(deps.chia as unknown as OfferWasm, req.offerStr);
    return { success: true, offerSummary: toWireSummary(summary) };
  }

  /**
   * Prepare (build + sign, don't broadcast) a TAKE or CANCEL and HOLD the bundle under a pending id.
   * Returns the two-sided summary for the user to approve before `confirmTrade` broadcasts it.
   */
  private async prepareTrade(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.offerStr) return { success: false, code: 'BAD_REQUEST', message: 'offerStr required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const build = req.tradeKind === 'cancel' ? cancelOffer : takeOffer;
    const prepared = await build(deps.chia as unknown as OfferWasm, deps.chain, {
      seed,
      offerStr: req.offerStr,
      ...(req.fee ? { fee: BigInt(req.fee) } : {}),
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
    });
    const pendingId = crypto.randomUUID();
    this.pendingTrades.set(pendingId, { bundle: prepared.bundle, inputCoinId: prepared.inputCoinId });
    return { success: true, pendingId, offerSummary: toWireSummary(prepared.summary) };
  }

  /** BROADCAST a previously-prepared trade (the approved step). Consumes the pending entry. */
  private async confirmTrade(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const held = req.pendingId ? this.pendingTrades.get(req.pendingId) : undefined;
    if (!held) return { success: false, code: 'NO_PENDING', message: 'no matching pending trade' };
    const push = await deps.chain.pushSpendBundle(held.bundle);
    this.pendingTrades.delete(req.pendingId!);
    if (!push.success) return { success: false, code: 'PUSH_FAILED', message: push.error ?? 'broadcast failed' };
    return { success: true, spentCoinId: held.inputCoinId };
  }

  /** LIST the wallet's NFTs (§18 Collectibles) — both HD schemes, discovered by hint. Read-only. */
  private async listNfts(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const nfts = await listNfts(deps.chia as unknown as NftWasm, deps.chain, {
      seed,
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
    });
    return { success: true, nfts };
  }

  /**
   * Prepare (build, don't sign/broadcast) an NFT transfer and HOLD it under a pending id — the SAME
   * pending map + `confirmSend` broadcast path as a coin send (an NFT transfer is just a spend). The
   * UI approves via `confirmSend` (mapped from `confirmNftTransfer`) and polls via `sendStatus`.
   */
  private async prepareNftTransfer(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherId || !req.recipient) return { success: false, code: 'BAD_REQUEST', message: 'launcherId + recipient required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as NftWasm;
    const prepared = await prepareNftTransfer(chia, deps.chain, {
      seed,
      launcherId: req.launcherId,
      recipient: req.recipient,
      fee: BigInt(req.fee ?? '0'),
      ...(req.gapLimit ? { gapLimit: req.gapLimit } : {}),
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => (deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b).replace(/^0x/i, '').toLowerCase();
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds });
    return { success: true, pendingId, nftSummary: prepared.summary };
  }

  /**
   * Derive the wallet's HD keyring (both schemes to `gapLimit`) — the standard puzzle hashes +
   * synthetic public/secret keys a dApp request is decoded against and signed with. Offscreen-only
   * (holds the seed). Returns `null` when locked / no wasm.
   */
  private async heldKeyring(deps: VaultDeps, gapLimit?: number): Promise<ReturnType<typeof buildKeyring> | null> {
    if (!deps.chia) return null;
    const seed = await this.heldSeed();
    if (!seed) return null;
    return buildKeyring(deps.chia as unknown as SendFlowWasm, seed, { count: gapLimit ?? 20 });
  }

  /** The wallet's synthetic public keys (hex, deduped) — CHIP-0002 `getPublicKeys` for a dApp. */
  private async getPublicKeys(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'derivation unavailable' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const keyring = await this.heldKeyring(deps, req.gapLimit);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const publicKeys = [...new Set(keyring.map((k) => strip0x(deps.chia!.toHex(k.pk.toBytes()))))];
    return { success: true, publicKeys };
  }

  /**
   * The wallet's UNSPENT coins for one asset — XCH at the derived inner (p2) puzzle hashes, or a CAT
   * at its CAT puzzle hash (`catPuzzleHash(tail, innerPh)`) over the same inner hashes — both HD
   * schemes to `gapLimit`. Asset routing is purely by `assetId` (undefined / `'xch'` = native XCH;
   * any other value = a CAT TAIL), the same rule the send flow uses (regression-guards the #121
   * asset-drop). Returns `null` when locked / no wasm. Offscreen-only (derives from the held seed).
   */
  private async heldAssetCoins(deps: VaultDeps, assetId?: string, gapLimit?: number): Promise<ChainCoin[] | null> {
    if (!deps.chia || !deps.chain) return null;
    const seed = await this.heldSeed();
    if (!seed) return null;
    const chia = deps.chia;
    const accounts = deriveAccounts(chia, seed, { schemes: ['unhardened', 'hardened'], count: gapLimit ?? DEFAULT_GAP_LIMIT });
    const innerPhs = accounts.map((a) => a.puzzleHashHex);
    const isCat = !!assetId && assetId.toLowerCase() !== 'xch';
    if (!isCat) return deps.chain.unspentCoins(innerPhs);
    const assetIdBytes = chia.fromHex(strip0x(assetId as string));
    const catPhs = innerPhs.map((ph) => strip0x(chia.toHex(chia.catPuzzleHash(assetIdBytes, chia.fromHex(ph)))));
    return deps.chain.unspentCoins(catPhs);
  }

  /**
   * CHIP-0002 `getAssetBalance` for a dApp: the wallet-wide aggregate for one asset (any CAT by
   * assetId, or native XCH). `confirmed === spendable` (no cross-call coin reservation) with the
   * backing coin count. Read-only.
   */
  private async getAssetBalance(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const coins = await this.heldAssetCoins(deps, req.assetId, req.gapLimit);
    if (!coins) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const total = coins.reduce((s, c) => s + c.amount, 0n).toString();
    return { success: true, assetBalance: { confirmed: total, spendable: total, spendableCoinCount: coins.length } };
  }

  /**
   * CHIP-0002 `getAssetCoins` for a dApp: the wallet's spendable coins for one asset (coin identity +
   * name; `locked:false`). Read-only — a dApp selects coins from this to build a spend it then hands
   * back to `signCoinSpends`.
   */
  private async getAssetCoins(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const coins = await this.heldAssetCoins(deps, req.assetId, req.gapLimit);
    if (!coins) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia;
    const assetCoins: WireSpendableCoin[] = coins.map((c) => ({
      coin: {
        parentCoinInfo: strip0x(chia.toHex(c.parentCoinInfo)),
        puzzleHash: strip0x(chia.toHex(c.puzzleHash)),
        amount: c.amount.toString(),
      },
      coinName: strip0x(chia.toHex(c.coinId())),
      locked: false,
    }));
    return { success: true, assetCoins };
  }

  /**
   * Decode a tamper-resistant summary (§5.5) from dApp-supplied coin spends — what the approval window
   * shows. Never signs. Derived from the built spend + the wallet's own address/key sets (self-vs-
   * external classification + which signers we can satisfy).
   */
  private async decodeDappSpend(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'decode unavailable' };
    if (!req.coinSpends || req.coinSpends.length === 0) return { success: false, code: 'BAD_REQUEST', message: 'coinSpends required' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const keyring = await this.heldKeyring(deps, req.gapLimit);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as DappSignWasm;
    const ownPh = keyring.map((k) => k.puzzleHashHex);
    const ownPk = keyring.map((k) => strip0x(chia.toHex(k.pk.toBytes())));
    const dappSummary = decodeDappSpend(chia, req.coinSpends, ownPh, MAINNET_AGG_SIG_ME, ownPk);
    return { success: true, dappSummary };
  }

  /**
   * Sign dApp-supplied coin spends (the APPROVED step) and return the aggregated BLS signature (hex).
   * `MISSING_KEY` if the wallet can't satisfy a required signer (never emits an invalid signature). The
   * dApp broadcasts — the extension does not push a dApp-signed bundle.
   */
  private async signDappSpend(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'signing unavailable' };
    if (!req.coinSpends || req.coinSpends.length === 0) return { success: false, code: 'BAD_REQUEST', message: 'coinSpends required' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const keyring = await this.heldKeyring(deps, req.gapLimit);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    try {
      const { signatureHex } = signDappCoinSpends(deps.chia as unknown as DappSignWasm, req.coinSpends, keyring.map((k) => k.sk), MAINNET_AGG_SIG_ME);
      return { success: true, signature: signatureHex };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'sign failed';
      if (msg.startsWith('MISSING_KEY')) return { success: false, code: 'MISSING_KEY', message: msg };
      throw e;
    }
  }

  /** Sign a dApp message (the APPROVED step): raw-bytes BLS sign with the wallet key + report the signer. */
  private async signMessage(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'signing unavailable' };
    if (req.message == null || req.message === '') return { success: false, code: 'BAD_REQUEST', message: 'message required' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const keyring = await this.heldKeyring(deps, req.gapLimit);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    try {
      const bytes = new TextEncoder().encode(req.message);
      const { signatureHex, publicKeyHex } = signMessageCustody(deps.chia as unknown as DappSignWasm, bytes, keyring.map((k) => k.sk), req.publicKey);
      return { success: true, signature: signatureHex, signerPublicKey: publicKeyHex };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'sign failed';
      if (msg.startsWith('MISSING_KEY')) return { success: false, code: 'MISSING_KEY', message: msg };
      throw e;
    }
  }

  /**
   * BROADCAST a dApp-built, already-signed spend bundle (CHIP-0002 `sendTransaction`, the APPROVED
   * step). Reassembles the wasm `SpendBundle` from the wire coin spends + the aggregated BLS signature
   * (hex) and pushes it via coinset. The wallet is a RELAY here — it holds no key for this and does
   * NOT re-sign; the approval window (which decoded a tamper-resistant summary from the coin spends)
   * is the gate. Only reached after explicit user approval.
   */
  private async broadcastDappBundle(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.coinSpends || req.coinSpends.length === 0) return { success: false, code: 'BAD_REQUEST', message: 'coinSpends required' };
    if (!req.aggregatedSignature) return { success: false, code: 'BAD_REQUEST', message: 'aggregatedSignature required' };
    const chia = deps.chia as unknown as DappSignWasm & {
      Signature: { fromBytes(bytes: Uint8Array): unknown };
      SpendBundle: new (coinSpends: SigCoinSpend[], signature: unknown) => ChainSpendBundle;
    };
    const { coinSpends } = reconstructCoinSpends(chia, req.coinSpends);
    const signature = chia.Signature.fromBytes(chia.fromHex(strip0x(req.aggregatedSignature)));
    const bundle = new chia.SpendBundle(coinSpends, signature);
    const push = await deps.chain.pushSpendBundle(bundle);
    if (!push.success) return { success: false, code: 'PUSH_FAILED', message: push.error ?? 'broadcast failed' };
    return { success: true };
  }
}

/** Strip a leading `0x` and lower-case a hex string. */
function strip0x(h: string): string {
  return h.replace(/^0x/i, '').toLowerCase();
}
