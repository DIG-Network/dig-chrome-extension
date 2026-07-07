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
import { scanBalances, receiveAddress, type ScanWasm, type BalanceScan } from '@/offscreen/scan';
import { deriveAccounts } from '@/lib/keystore/derive';
import type { ChainClient, ChainCoin } from '@/offscreen/chain';
import { prepareXchSend, prepareCatSend, signAndBundle, buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import { listCoins as buildCoinList, prepareSplit as buildSplit, prepareCombine as buildCombine, type CoinsWasm, type CoinInfo, type CoinOpSummary } from '@/offscreen/coins';
import {
  listNfts,
  prepareNftTransfer,
  prepareNftBulkTransfer,
  prepareNftBulkBurn,
  prepareNftMint,
  type NftWasm,
  type WalletNft,
  type NftTransferSummary,
  type NftBulkTransferSummary,
  type NftMintSummary,
} from '@/offscreen/nfts';
import { listDids, prepareDidCreate, prepareDidTransfer, prepareDidProfileUpdate, type DidWasm, type WalletDid, type DidCreateSummary, type DidTransferSummary, type DidProfileUpdateSummary } from '@/offscreen/dids';
import { prepareNftDidAssign, type AssignWasm, type NftDidAssignSummary } from '@/offscreen/didAssign';
import { MAINNET_AGG_SIG_ME, type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import { decodeDappSpend, reconstructCoinSpends, signDappCoinSpends, signMessageCustody, type DappSignWasm, type DappSpendSummary, type WireCoinSpend } from '@/offscreen/dappSign';
import { makeOffer, inspectOffer, takeOffer, cancelOffer, type OfferWasm, type OfferAsset, type OfferLeg, type OfferSummary } from '@/offscreen/offers';
import type { ChainSpendBundle } from '@/offscreen/chain';
import {
  discoverIncomingClawbacks,
  findClawbackCoin,
  prepareClawbackAction as buildClawbackAction,
  type ClawbackInfo,
  type ClawbackWasm,
} from '@/offscreen/clawback';

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

/**
 * Wire-safe (JSON, no bigint) asset descriptor crossing the SW boundary. `nft` is OFFERED-side only
 * (§94) — see `offers.ts`'s module doc for why a REQUESTED nft leg and a `did` leg are not supported.
 */
export type WireOfferAsset = { kind: 'xch' } | { kind: 'cat'; assetId: string } | { kind: 'nft'; launcherId: string };
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
/** #154 — the activity-log `asset` label for one side of an offer: `'XCH'`, the CAT TAIL hex, or a
 * synthetic `'NFT'` label (an offered NFT leg carries a launcher id, not a fungible asset id). */
const offerAssetLabel = (asset: OfferAsset): string => (asset.kind === 'xch' ? 'XCH' : asset.kind === 'cat' ? asset.assetId : 'NFT');

/**
 * Minimal, uniform activity-log hint (#154) captured at PREPARE time and carried on the pending
 * entry so the shared `confirmSend`/`confirmTrade` broadcast step can hand it back regardless of
 * which action kind (send / NFT transfer / NFT mint / DID create-transfer-profile-assign / trade)
 * reused that generic path. `src/background/index.ts` uses it to log a LOCAL activity entry the
 * moment the spend broadcasts (see `src/lib/activity-log.ts`) — never an on-chain reconstruction.
 * `counterparty` is the address the spend actually pays, already known at prepare time (the user's
 * own `recipient` input for a send/transfer) — no address re-derivation needed; `null` for a
 * self-only spend (mint / DID create / profile update / DID assignment / split / combine), which
 * the SW does not log as a "sent" entry (nothing was sent to anyone).
 */
export interface ActivityHint {
  asset: string;
  amount: string;
  counterparty: string | null;
}

/** Wire-safe (JSON, no bigint) clawback params (#152) crossing the SW↔vault boundary. */
export interface WireClawbackInfo {
  senderPuzzleHashHex: string;
  receiverPuzzleHashHex: string;
  /** Absolute unix timestamp (decimal string) — NOT a duration. */
  seconds: string;
  amount: string;
}
const toWireClawbackInfo = (info: ClawbackInfo): WireClawbackInfo => ({
  senderPuzzleHashHex: info.senderPuzzleHashHex,
  receiverPuzzleHashHex: info.receiverPuzzleHashHex,
  seconds: info.seconds.toString(),
  amount: info.amount.toString(),
});
const fromWireClawbackInfo = (w: WireClawbackInfo): ClawbackInfo => ({
  senderPuzzleHashHex: w.senderPuzzleHashHex,
  receiverPuzzleHashHex: w.receiverPuzzleHashHex,
  seconds: BigInt(w.seconds),
  amount: BigInt(w.amount),
});

/**
 * One entry in the #152 clawback management list — either an INCOMING pending claim (discovered on
 * chain by hint, `listClawbacks` needs no candidate for these) or an OUTGOING pending reclaim (the
 * vault has no on-chain way to enumerate a wallet's own past clawback sends, so the CALLER supplies
 * candidates from its own local activity log, #154, and the vault reports back only the ones still
 * actually pending — i.e. still unspent — on chain right now).
 */
export interface WireClawback {
  direction: 'incoming' | 'outgoing';
  info: WireClawbackInfo;
  coinIdHex: string;
}

/** The keystore operations the vault handles (mirrors the SW custody actions). */
export type VaultOp =
  | 'createWallet'
  | 'importWallet'
  | 'unlockWallet'
  | 'lockWallet'
  | 'revealPhrase'
  // Multi-wallet switcher (#90): activate an already-unlocked wallet / drop one wallet's cached key.
  | 'switchWallet'
  | 'forgetWallet'
  | 'getVaultState'
  | 'getReceiveAddress'
  | 'scanBalances'
  | 'prepareSend'
  | 'confirmSend'
  | 'sendStatus'
  | 'makeOffer'
  | 'inspectOffer'
  | 'prepareTrade'
  | 'confirmTrade'
  | 'listNfts'
  | 'prepareNftTransfer'
  // Bulk transfer/burn (#171 — Collectibles multi-select): move or burn MULTIPLE selected NFTs in ONE
  // spend; broadcast via the shared confirmSend path exactly like a single-NFT transfer.
  | 'prepareNftBulkTransfer'
  | 'prepareNftBulkBurn'
  // NFT minting (#92): build a new NFT (CHIP-0007 metadata + royalty); broadcast via confirmSend.
  | 'prepareNftMint'
  // DID management (#93): create/list/transfer/profile-update a self-custody identity; broadcast via confirmSend.
  | 'listDids'
  | 'prepareDidCreate'
  | 'prepareDidTransfer'
  | 'prepareDidProfileUpdate'
  // Assign a wallet-owned DID as an NFT's owner (#93); broadcast via confirmSend.
  | 'prepareNftDidAssign'
  // Coin control (#91): per-asset coin listing + split / combine self-sends.
  | 'listCoins'
  | 'prepareSplit'
  | 'prepareCombine'
  // Clawback (#152): list pending incoming/outgoing clawbacks; build the CLAIM (receiver) / CLAW
  // BACK (sender) spend — broadcast via the shared confirmSend path. Send-WITH-clawback is the
  // ordinary 'prepareSend' plus its `clawbackSeconds` field (no separate op).
  | 'listClawbacks'
  | 'prepareClawbackAction'
  // dApp `window.chia` RPC (§5.5): identity read + approval-gated foreign-spend / message signing.
  | 'getPublicKeys'
  | 'getAssetBalance'
  | 'getAssetCoins'
  | 'decodeDappSpend'
  | 'signDappSpend'
  | 'signMessage'
  | 'broadcastDappBundle';

/**
 * Wire-safe (JSON, no bigint) NFT mint inputs (#92) crossing the SW→vault boundary. URIs are plain
 * strings, hashes are hex, and edition/fee amounts are decimal strings; the vault converts to bigint.
 */
export interface WireNftMintParams {
  dataUris: string[];
  dataHash?: string;
  metadataUris?: string[];
  metadataHash?: string;
  licenseUris?: string[];
  licenseHash?: string;
  editionNumber?: string;
  editionTotal?: string;
  royaltyBasisPoints?: number;
  royaltyAddress?: string;
  fee?: string;
}

/** A request forwarded from the SW to the vault. `record` is the persisted DIGWX1 blob for ops that need it. */
export interface VaultRequest {
  op: VaultOp;
  password?: string;
  mnemonic?: string;
  label?: string;
  /**
   * Multi-wallet id (#90): which registry wallet this op targets. create/import/unlock cache the
   * decrypted key under this id and make it active; switchWallet/forgetWallet act on it. Omitted =
   * the legacy single-wallet slot.
   */
  walletId?: string;
  /** Use the STRONG (256 MiB) Argon2 preset for a high-value wallet. */
  strong?: boolean;
  /** The persisted keystore record (SW reads it from storage for unlock / reveal). */
  record?: Digwx1Record;
  /** Watched CAT asset ids (TAILs) to scan for balances. */
  watchedCats?: string[];
  /**
   * The wallet's single ACTIVE HD derivation index (§165 — the single active-index model). Every
   * derive/scan/send op derives ONLY this index (both schemes) — never a multi-index sweep. Default 0.
   */
  activeIndex?: number;
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
  /** Coin control (#91): the coins to split/combine, or the coins to fund a send (hex ids). */
  coinIds?: string[];
  /** prepareSplit: how many self coins to split into (≥2). */
  outputs?: number;
  /** prepareSend (#152): send WITH a clawback window — an absolute unix timestamp (decimal string)
   * after which the receiver may claim; before it, only the sender may claw back. XCH only (v1). */
  clawbackSeconds?: string;
  /** prepareClawbackAction: which side is acting — claim (receiver) or claw back (sender). */
  direction?: 'claim' | 'reclaim';
  /** prepareClawbackAction: the locked coin's params (from `listClawbacks`/the original send). */
  clawbackInfo?: WireClawbackInfo;
  /** listClawbacks (#152): the caller's own OUTGOING candidates (from its local activity log) to
   * check against live chain state — the vault has no other way to enumerate a wallet's past sends. */
  clawbackCandidates?: WireClawbackInfo[];
  /** makeOffer: the leg the wallet gives / the leg it wants (wire-safe, string amounts). */
  offered?: WireOfferLeg;
  requested?: WireOfferLeg;
  /** inspectOffer / prepareTrade: the `offer1…` string. */
  offerStr?: string;
  /** prepareTrade: whether to TAKE (fund + accept) or CANCEL (reclaim) the offer. */
  tradeKind?: 'take' | 'cancel';
  /** prepareNftTransfer / prepareDidTransfer / prepareDidProfileUpdate: the asset's launcher id (hex).
   * prepareNftDidAssign: the NFT's launcher id (the DID's is {@link didLauncherId}). */
  launcherId?: string;
  /** prepareNftBulkTransfer / prepareNftBulkBurn (#171): the launcher ids (hex) of EVERY selected NFT
   * to move/burn in one spend. `recipient` (above) is required for a bulk TRANSFER, ignored for a
   * bulk BURN (the destination is the fixed well-known burn puzzle hash). */
  launcherIds?: string[];
  /** prepareNftDidAssign (#93): the DID's launcher id (hex) to assign as the NFT's owner. */
  didLauncherId?: string;
  /** prepareDidProfileUpdate (#93): the new on-chain profile name (plain UTF-8). */
  profileName?: string;
  /** prepareNftMint (#92): the CHIP-0007 metadata + royalty + fee inputs for a new NFT. */
  nftMint?: WireNftMintParams;
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
  /** prepareSend (#152): present iff `clawbackSeconds` was given — the params the caller needs to
   * later list/claim/claw-back this send (persist alongside the activity-log entry, #154). */
  clawbackInfo?: WireClawbackInfo;
  /** listClawbacks (#152): the wallet's currently-pending incoming + outgoing clawbacks. */
  clawbacks?: WireClawback[];
  /** prepareClawbackAction (#152): the decoded amount actually delivered (== the coin's amount minus fee). */
  clawbackAmountOut?: string;
  /** confirmSend: an input coin id (hex) to poll for confirmation. */
  spentCoinId?: string;
  /** sendStatus: whether the spend has confirmed on-chain. */
  confirmed?: boolean;
  /** confirmSend/confirmTrade (#154): the activity-log hint captured at prepare time — see
   * {@link ActivityHint}. Absent for a self-only spend (mint / DID / split / combine) the caller
   * should not log as a "sent" entry. */
  activityHint?: ActivityHint;
  /** makeOffer: the shareable `offer1…` string. */
  offer?: string;
  /** makeOffer / inspectOffer / prepareTrade: the decoded two-sided summary. */
  offerSummary?: WireOfferSummary;
  /** listNfts: the wallet's NFTs (both HD schemes), wire-safe. */
  nfts?: WalletNft[];
  /** prepareNftTransfer: the decoded transfer summary to approve. */
  nftSummary?: NftTransferSummary;
  /** prepareNftBulkTransfer / prepareNftBulkBurn (#171): the decoded bulk summary (every launcher id
   * moved, the destination, fee, and whether it's a burn) to approve. */
  nftBulkSummary?: NftBulkTransferSummary;
  /** prepareNftMint (#92): the decoded (tamper-resistant) mint summary to approve. */
  nftMintSummary?: NftMintSummary;
  /** prepareNftMint (#92): the new NFT's launcher id (hex). */
  launcherId?: string;
  /** listDids (#93): the wallet's DIDs (both HD schemes), wire-safe. */
  dids?: WalletDid[];
  /** prepareDidCreate (#93): the decoded (tamper-resistant) create summary to approve. */
  didCreateSummary?: DidCreateSummary;
  /** prepareDidTransfer (#93): the decoded transfer summary to approve. */
  didSummary?: DidTransferSummary;
  /** prepareDidProfileUpdate (#93): the decoded profile-update summary to approve. */
  didProfileSummary?: DidProfileUpdateSummary;
  /** prepareNftDidAssign (#93): the decoded NFT↔DID assignment summary to approve. */
  nftDidAssignSummary?: NftDidAssignSummary;
  /** listCoins: the wallet's unspent coins for the requested asset. */
  coins?: CoinInfo[];
  /** prepareSplit / prepareCombine: the decoded (tamper-resistant) coin-op summary to approve. */
  coinOpSummary?: CoinOpSummary;
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
  /** #154 — the activity-log hint `confirmSend` hands back on broadcast; see {@link ActivityHint}. */
  activityHint?: ActivityHint;
  /** #152 — present iff this was a send-WITH-clawback; `confirmSend` hands it back on broadcast so
   * the caller can persist it alongside the activity-log entry (needed to later claim/claw it back). */
  clawbackInfo?: ClawbackInfo;
}

/** The vault slot a legacy (pre-#90) single-wallet caller uses when it supplies no wallet id. */
const DEFAULT_WALLET_ID = 'default';

export class Vault {
  /**
   * The decrypted BIP-39 entropy per UNLOCKED wallet, keyed by wallet id — the ONLY secret held, in
   * memory only (§5.1). Several of the user's OWN wallets may be unlocked at once within the shared
   * unlock window so switching between them is instant; every key is zeroized together on lock. A
   * legacy single-wallet caller (no walletId) uses the {@link DEFAULT_WALLET_ID} slot.
   */
  private keys = new Map<string, Uint8Array>();

  /** The active wallet id — the wallet every derived op (derive / scan / send / sign) reads. */
  private activeId: string | null = null;

  /** Prepared sends awaiting user approval → confirm (cleared on confirm / lock). */
  private pending = new Map<string, PendingSend>();

  /** Prepared trades (take/cancel) — a signed bundle held between approval and broadcast. */
  private pendingTrades = new Map<string, { bundle: ChainSpendBundle; inputCoinId: string; activityHint?: ActivityHint }>();

  /** True iff the ACTIVE wallet's decrypted key is currently held in memory. */
  hasKey(): boolean {
    return this.activeId !== null && this.keys.has(this.activeId);
  }

  /** Zeroize + drop EVERY held secret (best-effort). Idempotent. Also drops any pending sends. */
  lock(): void {
    for (const e of this.keys.values()) e.fill(0);
    this.keys.clear();
    this.activeId = null;
    this.pending.clear();
    this.pendingTrades.clear();
  }

  /**
   * Hold `entropy` for `walletId` (zeroizing any prior copy for the SAME id) and make it active. Other
   * unlocked wallets are left intact so switching back to them stays instant (§90).
   */
  private hold(entropy: Uint8Array, walletId: string = DEFAULT_WALLET_ID): void {
    const prev = this.keys.get(walletId);
    if (prev) prev.fill(0);
    this.keys.set(walletId, entropy);
    this.activeId = walletId;
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
        case 'switchWallet':
          return this.switchWallet(req);
        case 'forgetWallet':
          return this.forgetWallet(req);
        case 'getVaultState':
          return { success: true, hasKey: this.hasKey() };
        case 'getReceiveAddress':
          return await this.getReceiveAddress(req, deps);
        case 'scanBalances':
          return await this.scanBalances(req, deps);
        case 'prepareSend':
          return await this.prepareSend(req, deps);
        case 'confirmSend':
          return await this.confirmSend(req, deps);
        case 'sendStatus':
          return await this.sendStatus(req, deps);
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
        case 'prepareNftBulkTransfer':
          return await this.prepareNftBulkTransfer(req, deps);
        case 'prepareNftBulkBurn':
          return await this.prepareNftBulkBurn(req, deps);
        case 'prepareNftMint':
          return await this.prepareNftMint(req, deps);
        case 'listDids':
          return await this.listDids(req, deps);
        case 'prepareDidCreate':
          return await this.prepareDidCreate(req, deps);
        case 'prepareDidTransfer':
          return await this.prepareDidTransfer(req, deps);
        case 'prepareDidProfileUpdate':
          return await this.prepareDidProfileUpdate(req, deps);
        case 'prepareNftDidAssign':
          return await this.prepareNftDidAssign(req, deps);
        case 'listCoins':
          return await this.listCoins(req, deps);
        case 'prepareSplit':
          return await this.prepareSplit(req, deps);
        case 'prepareCombine':
          return await this.prepareCombine(req, deps);
        case 'listClawbacks':
          return await this.listClawbacks(req, deps);
        case 'prepareClawbackAction':
          return await this.prepareClawbackAction(req, deps);
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
      // Never leak internals — BUT don't collapse a domain-specific throw to a generic code either
      // (#179: this used to swallow dids.ts/nfts.ts's `NO_XCH_COINS`/`NO_SUITABLE_COIN` etc, so the
      // UI could never tell a funding problem from any other failure). Domain code throughout this
      // vault (dids.ts, nfts.ts, sendFlow.ts, …) follows a `CODE: message` convention on a plain
      // `Error` — extract that leading code (same convention already used locally by
      // `signDappSpend`/`signMessage`'s `msg.startsWith('MISSING_KEY')`) before falling back to a
      // generic `VAULT_ERROR` for a throw that carries no such code.
      if (e instanceof KeystoreError) return { success: false, code: e.code, message: e.message };
      const msg = e instanceof Error ? e.message : undefined;
      const codeMatch = msg ? /^([A-Z][A-Z0-9_]*):/.exec(msg) : null;
      if (codeMatch) return { success: false, code: codeMatch[1], message: msg };
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
    this.hold(entropy, req.walletId);
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
    this.hold(entropy, req.walletId);
    return { success: true, hasKey: true, record, usedFallback };
  }

  private async unlockWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password || !req.record) {
      return { success: false, code: 'BAD_REQUEST', message: 'password and record required' };
    }
    const entropy = await decryptEntropy(req.record, req.password, deps.argon2Fn);
    this.hold(entropy, req.walletId);
    return { success: true, hasKey: true };
  }

  /**
   * Make another ALREADY-UNLOCKED wallet active (instant, no password). Returns `NEEDS_UNLOCK` when
   * the target wallet's key is not cached this session, so the SW prompts for its password and then
   * unlocks it. Switching drops the previous wallet's pending sends/trades (they are keyed to its
   * coins/keys).
   */
  private switchWallet(req: VaultRequest): VaultResponse {
    if (!req.walletId) return { success: false, code: 'BAD_REQUEST', message: 'walletId required' };
    if (!this.keys.has(req.walletId)) return { success: false, code: 'NEEDS_UNLOCK', message: 'wallet not unlocked' };
    this.activeId = req.walletId;
    this.pending.clear();
    this.pendingTrades.clear();
    return { success: true, hasKey: true };
  }

  /** Zeroize + drop ONE wallet's cached key (used when removing a wallet). Idempotent. */
  private forgetWallet(req: VaultRequest): VaultResponse {
    if (req.walletId) {
      const e = this.keys.get(req.walletId);
      if (e) e.fill(0);
      this.keys.delete(req.walletId);
      if (this.activeId === req.walletId) {
        this.activeId = null;
        this.pending.clear();
        this.pendingTrades.clear();
      }
    }
    return { success: true, hasKey: this.hasKey() };
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

  /** The active wallet's held entropy (or null when the active wallet is locked / absent). */
  private activeEntropy(): Uint8Array | null {
    return this.activeId ? this.keys.get(this.activeId) ?? null : null;
  }

  /** Derive the active wallet's BIP-39 seed from its in-memory entropy (never leaves the vault). */
  private async heldSeed(): Promise<Uint8Array | null> {
    const entropy = this.activeEntropy();
    if (!entropy) return null;
    return mnemonicToSeed(entropyToMnemonic(entropy));
  }

  private async getReceiveAddress(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'derivation unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    return { success: true, address: receiveAddress(deps.chia, seed, req.activeIndex ?? 0) };
  }

  private async scanBalances(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const balances = await scanBalances(deps.chia, deps.chain, {
      seed,
      ...(req.watchedCats ? { watchedCats: req.watchedCats } : {}),
      activeIndex: req.activeIndex ?? 0,
    });
    return { success: true, balances };
  }

  /**
   * Prepare (build, don't sign/broadcast) an XCH send and HOLD it under a pending id. Returns the
   * decoded summary derived from the built spend for the user to approve. `chia` is the full wasm.
   *
   * `clawbackSeconds` (#152): send WITH a clawback window instead of a plain send — XCH only (v1);
   * a CAT send with `clawbackSeconds` is rejected (`BAD_REQUEST`) rather than silently ignored.
   */
  private async prepareSend(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.recipient || req.amount == null) return { success: false, code: 'BAD_REQUEST', message: 'recipient + amount required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as SendFlowWasm;
    const isCat = !!req.assetId && req.assetId.toLowerCase() !== 'xch';
    if (req.clawbackSeconds != null && isCat) {
      return { success: false, code: 'BAD_REQUEST', message: 'clawback is supported for XCH sends only (v1)' };
    }
    // Coin control (#91): a hand-picked coin selection overrides the driver's auto-selection.
    const selection = req.coinIds && req.coinIds.length ? { selectedCoinIds: req.coinIds } : {};
    const prepared = isCat
      ? await prepareCatSend(chia, deps.chain, {
          seed,
          assetId: req.assetId as string,
          recipient: req.recipient,
          amount: BigInt(req.amount),
          fee: BigInt(req.fee ?? '0'),
          activeIndex: req.activeIndex ?? 0,
          ...selection,
        })
      : await prepareXchSend(chia, deps.chain, {
          seed,
          recipient: req.recipient,
          amount: BigInt(req.amount),
          fee: BigInt(req.fee ?? '0'),
          activeIndex: req.activeIndex ?? 0,
          ...selection,
          ...(req.clawbackSeconds != null ? { clawbackSeconds: BigInt(req.clawbackSeconds) } : {}),
        });
    const pendingId = crypto.randomUUID();
    const inputCoinIds = prepared.coinSpends.map((cs) => chia.toHex(cs.coin.coinId()).replace(/^0x/i, '').toLowerCase());
    // #154 — the counterparty is already the user's own `recipient` input, no re-derivation needed.
    const activityHint: ActivityHint = { asset: prepared.summary.asset, amount: prepared.summary.sent, counterparty: req.recipient };
    const clawbackInfo = 'clawbackInfo' in prepared ? prepared.clawbackInfo : undefined;
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint, clawbackInfo });
    return { success: true, pendingId, summary: prepared.summary, ...(clawbackInfo ? { clawbackInfo: toWireClawbackInfo(clawbackInfo) } : {}) };
  }

  /**
   * Sign + broadcast a previously-prepared send (the APPROVED step — the only place a real spend is
   * pushed). Consumes the pending entry; returns an input coin id to poll for confirmation, plus the
   * #154 {@link ActivityHint} captured at prepare time — every action that reuses this shared path
   * (NFT transfer/mint, DID create/transfer/profile-update/assign) gets it back for free, so the SW
   * can log a local activity entry without re-deriving anything.
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
    return {
      success: true,
      spentCoinId: held.inputCoinIds[0],
      ...(held.activityHint ? { activityHint: held.activityHint } : {}),
      ...(held.clawbackInfo ? { clawbackInfo: toWireClawbackInfo(held.clawbackInfo) } : {}),
    };
  }

  /** Poll whether a broadcast send has confirmed (an input coin is now recorded spent). */
  private async sendStatus(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.coinId) return { success: false, code: 'BAD_REQUEST', message: 'coinId required' };
    return { success: true, confirmed: await deps.chain.coinConfirmed(req.coinId) };
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
      activeIndex: req.activeIndex ?? 0,
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
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    // #154 — log the OFFERED side's first leg as the trade's headline asset/amount; a trade has no
    // single "counterparty" (a public offer may be taken by anyone), so counterparty stays null. A
    // TAKE's summary carries both legs; a CANCEL's is currently always empty (offers.ts reclaims the
    // maker's coins without reconstructing a summary) — fall back to a generic XCH/0 placeholder so a
    // cancelled trade still logs a real (if unlabelled) entry rather than none at all.
    const firstLeg = prepared.summary.offered[0] ?? prepared.summary.requested[0];
    const activityHint: ActivityHint = firstLeg
      ? { asset: offerAssetLabel(firstLeg.asset), amount: firstLeg.amount.toString(), counterparty: null }
      : { asset: 'XCH', amount: '0', counterparty: null };
    this.pendingTrades.set(pendingId, { bundle: prepared.bundle, inputCoinId: prepared.inputCoinId, activityHint });
    return { success: true, pendingId, offerSummary: toWireSummary(prepared.summary) };
  }

  /**
   * BROADCAST a previously-prepared trade (the approved step). Consumes the pending entry; returns
   * the #154 {@link ActivityHint} captured at prepare time so the SW can log a local 'trade' entry.
   */
  private async confirmTrade(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const held = req.pendingId ? this.pendingTrades.get(req.pendingId) : undefined;
    if (!held) return { success: false, code: 'NO_PENDING', message: 'no matching pending trade' };
    const push = await deps.chain.pushSpendBundle(held.bundle);
    this.pendingTrades.delete(req.pendingId!);
    if (!push.success) return { success: false, code: 'PUSH_FAILED', message: push.error ?? 'broadcast failed' };
    return { success: true, spentCoinId: held.inputCoinId, ...(held.activityHint ? { activityHint: held.activityHint } : {}) };
  }

  /** LIST the wallet's NFTs (§18 Collectibles) — both HD schemes, discovered by hint. Read-only. */
  private async listNfts(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const nfts = await listNfts(deps.chia as unknown as NftWasm, deps.chain, {
      seed,
      activeIndex: req.activeIndex ?? 0,
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
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => (deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b).replace(/^0x/i, '').toLowerCase();
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — an NFT transfer is a "sent" activity entry to the recipient the user already typed.
    const activityHint: ActivityHint = { asset: 'NFT', amount: '1', counterparty: req.recipient };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, nftSummary: prepared.summary };
  }

  /**
   * Prepare (build, don't sign/broadcast) a BULK transfer of every NFT in `req.launcherIds` to
   * `req.recipient` in ONE spend bundle (#171 — Collectibles multi-select) — the SAME pending map +
   * `confirmSend` broadcast path as a single NFT transfer.
   */
  private async prepareNftBulkTransfer(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherIds || req.launcherIds.length === 0 || !req.recipient) {
      return { success: false, code: 'BAD_REQUEST', message: 'launcherIds + recipient required' };
    }
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as NftWasm;
    const prepared = await prepareNftBulkTransfer(chia, deps.chain, {
      seed,
      launcherIds: req.launcherIds,
      recipient: req.recipient,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a bulk transfer is a "sent" activity entry to the recipient the user already typed;
    // amount carries the NFT COUNT (there is no fungible amount for a bundle of singletons).
    const activityHint: ActivityHint = { asset: 'NFT', amount: String(prepared.summary.launcherIds.length), counterparty: req.recipient };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, nftBulkSummary: prepared.summary };
  }

  /**
   * Prepare (build, don't sign/broadcast) a BULK BURN of every NFT in `req.launcherIds` — a transfer
   * to the well-known provably-unspendable puzzle hash in ONE spend bundle (#171). Irreversible once
   * `confirmSend` broadcasts it; this method only BUILDS the spend — the caller (the SW/UI) is
   * responsible for requiring the user's explicit, distinct destructive confirmation before ever
   * calling `confirmSend` on the returned pending id. Same pending map + broadcast path as a transfer.
   */
  private async prepareNftBulkBurn(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherIds || req.launcherIds.length === 0) {
      return { success: false, code: 'BAD_REQUEST', message: 'launcherIds required' };
    }
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as NftWasm;
    const prepared = await prepareNftBulkBurn(chia, deps.chain, {
      seed,
      launcherIds: req.launcherIds,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a burn's destination has no spending key, so it is NOT a real "sent to" counterparty;
    // the SW logs it under a distinct 'burn' activity kind regardless (it knows the action name).
    const activityHint: ActivityHint = { asset: 'NFT', amount: String(prepared.summary.launcherIds.length), counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, nftBulkSummary: prepared.summary };
  }

  /**
   * MINT a new NFT owned by this wallet (#92) — CHIP-0007 metadata (data/metadata/license URIs +
   * optional hashes) + royalty percentage (to the minter or a chosen address). Builds + holds the
   * spend under a pending id (broadcast via the shared `confirmSend`); returns the decoded, tamper-
   * resistant summary + the new launcher id. Does NOT sign or broadcast.
   */
  private async prepareNftMint(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const m = req.nftMint;
    if (!m || !Array.isArray(m.dataUris) || m.dataUris.length === 0) return { success: false, code: 'BAD_REQUEST', message: 'a data URI is required to mint' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as NftWasm;
    const prepared = await prepareNftMint(chia, deps.chain, {
      seed,
      dataUris: m.dataUris,
      ...(m.dataHash ? { dataHash: m.dataHash } : {}),
      ...(m.metadataUris ? { metadataUris: m.metadataUris } : {}),
      ...(m.metadataHash ? { metadataHash: m.metadataHash } : {}),
      ...(m.licenseUris ? { licenseUris: m.licenseUris } : {}),
      ...(m.licenseHash ? { licenseHash: m.licenseHash } : {}),
      ...(m.editionNumber ? { editionNumber: BigInt(m.editionNumber) } : {}),
      ...(m.editionTotal ? { editionTotal: BigInt(m.editionTotal) } : {}),
      ...(m.royaltyBasisPoints != null ? { royaltyBasisPoints: m.royaltyBasisPoints } : {}),
      ...(m.royaltyAddress ? { royaltyAddress: m.royaltyAddress } : {}),
      fee: BigInt(m.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a mint is a self-only spend (no external counterparty); the SW logs it as kind 'mint'
    // regardless (it knows the action name), so counterparty stays null on purpose.
    const activityHint: ActivityHint = { asset: 'NFT', amount: '1', counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, nftMintSummary: prepared.summary, launcherId: prepared.launcherId };
  }

  /** LIST the wallet's DIDs (#93) — both HD schemes, discovered by hint. Read-only. */
  private async listDids(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const dids = await listDids(deps.chia as unknown as DidWasm, deps.chain, {
      seed,
      activeIndex: req.activeIndex ?? 0,
    });
    return { success: true, dids };
  }

  /**
   * CREATE a new "simple" DID owned by this wallet (#93) — builds + holds the spend under a pending id
   * (broadcast via the shared `confirmSend`); returns the decoded, tamper-resistant summary + the new
   * launcher id. Does NOT sign or broadcast.
   */
  private async prepareDidCreate(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as DidWasm;
    const prepared = await prepareDidCreate(chia, deps.chain, {
      seed,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a DID create is a self-only spend; the SW logs it as kind 'did'.
    const activityHint: ActivityHint = { asset: 'DID', amount: '1', counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, didCreateSummary: prepared.summary, launcherId: prepared.launcherId };
  }

  /**
   * Prepare (build, don't sign/broadcast) a transfer of the wallet's DID and HOLD it under a pending id
   * — the SAME pending map + `confirmSend` broadcast path as a coin send (#93). The UI approves via
   * `confirmSend` (mapped from `confirmDidTransfer`) and polls via `sendStatus`.
   */
  private async prepareDidTransfer(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherId || !req.recipient) return { success: false, code: 'BAD_REQUEST', message: 'launcherId + recipient required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as DidWasm;
    const prepared = await prepareDidTransfer(chia, deps.chain, {
      seed,
      launcherId: req.launcherId,
      recipient: req.recipient,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a DID transfer is a "did" activity entry to the recipient the user already typed.
    const activityHint: ActivityHint = { asset: 'DID', amount: '1', counterparty: req.recipient };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, didSummary: prepared.summary };
  }

  /**
   * Prepare (build, don't sign/broadcast) a PROFILE update of the wallet's DID and HOLD it under a
   * pending id (#93) — the SAME pending map + `confirmSend` broadcast path as a coin send.
   */
  private async prepareDidProfileUpdate(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherId || !req.profileName) return { success: false, code: 'BAD_REQUEST', message: 'launcherId + profileName required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as DidWasm;
    const prepared = await prepareDidProfileUpdate(chia, deps.chain, {
      seed,
      launcherId: req.launcherId,
      profileName: req.profileName,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — a self-only spend (updates the wallet's own DID); logged as kind 'did'.
    const activityHint: ActivityHint = { asset: 'DID', amount: '0', counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, didProfileSummary: prepared.summary };
  }

  /**
   * Prepare (build, don't sign/broadcast) assigning the wallet's DID as the OWNER of the wallet's NFT
   * and HOLD it under a pending id (#93) — the SAME pending map + `confirmSend` broadcast path.
   */
  private async prepareNftDidAssign(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.launcherId || !req.didLauncherId) return { success: false, code: 'BAD_REQUEST', message: 'launcherId (NFT) + didLauncherId required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as AssignWasm;
    const prepared = await prepareNftDidAssign(chia, deps.chain, {
      seed,
      nftLauncherId: req.launcherId,
      didLauncherId: req.didLauncherId,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    const pendingId = crypto.randomUUID();
    const toHex = (b: Uint8Array): string => strip0x((deps.chia as unknown as { toHex(b: Uint8Array): string }).toHex(b));
    const inputCoinIds = prepared.coinSpends.map((cs) => toHex(cs.coin.coinId()));
    // #154 — assigning DID ownership of an NFT is a self-only spend; logged as kind 'did'.
    const activityHint: ActivityHint = { asset: 'NFT', amount: '0', counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, nftDidAssignSummary: prepared.summary };
  }

  /**
   * LIST the wallet's unspent coins for one asset (coin control #91) — native XCH at the derived inner
   * puzzle hashes, or a CAT at its CAT puzzle hash, both HD schemes. Each coin carries id + amount +
   * confirmed height. Read-only; routed purely by `assetId` (#121).
   */
  private async listCoins(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const coins = await buildCoinList(deps.chia as unknown as CoinsWasm, deps.chain, {
      seed,
      ...(req.assetId ? { assetId: req.assetId } : {}),
      activeIndex: req.activeIndex ?? 0,
    });
    return { success: true, coins };
  }

  /**
   * SPLIT one/more of the wallet's coins into N distinct self coins (coin control #91). Builds + holds
   * the spend under a pending id (broadcast via the shared `confirmSend`); returns the decoded,
   * tamper-resistant summary (self-send invariant enforced). Does NOT sign or broadcast.
   */
  private async prepareSplit(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.coinIds || req.coinIds.length === 0 || !req.outputs) return { success: false, code: 'BAD_REQUEST', message: 'coinIds + outputs required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as CoinsWasm;
    const prepared = await buildSplit(chia, deps.chain, {
      seed,
      ...(req.assetId ? { assetId: req.assetId } : {}),
      coinIds: req.coinIds,
      outputs: req.outputs,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    return this.holdCoinOp(chia, prepared);
  }

  /**
   * COMBINE two or more of the wallet's coins into a SINGLE self coin (coin control #91). Builds +
   * holds the spend under a pending id (broadcast via the shared `confirmSend`); returns the decoded
   * summary. Does NOT sign or broadcast.
   */
  private async prepareCombine(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.coinIds || req.coinIds.length < 2) return { success: false, code: 'BAD_REQUEST', message: 'at least two coinIds required' };
    const seed = await this.heldSeed();
    if (!seed) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as CoinsWasm;
    const prepared = await buildCombine(chia, deps.chain, {
      seed,
      ...(req.assetId ? { assetId: req.assetId } : {}),
      coinIds: req.coinIds,
      fee: BigInt(req.fee ?? '0'),
      activeIndex: req.activeIndex ?? 0,
    });
    return this.holdCoinOp(chia, prepared);
  }

  /** Hold a built split/combine under a pending id (confirmed via the shared `confirmSend`). */
  private holdCoinOp(chia: CoinsWasm, prepared: { coinSpends: SigCoinSpend[]; coinOpSummary: CoinOpSummary; secretKeys: SigSecretKey[] }): VaultResponse {
    const pendingId = crypto.randomUUID();
    const inputCoinIds = prepared.coinSpends.map((cs) => strip0x(chia.toHex(cs.coin.coinId())));
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds });
    return { success: true, pendingId, coinOpSummary: prepared.coinOpSummary };
  }

  /**
   * LIST the wallet's currently-pending clawbacks (#152) — INCOMING (discovered on chain by hint at
   * the ACTIVE index's own puzzle hashes) plus OUTGOING (the caller's `clawbackCandidates`, sourced
   * from its own local activity log, each checked against LIVE chain state and included only if still
   * actually pending — i.e. not yet claimed or reclaimed). Read-only.
   */
  private async listClawbacks(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    const keyring = await this.heldKeyring(deps, req.activeIndex);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as ClawbackWasm;
    const incoming = await discoverIncomingClawbacks(chia, deps.chain, keyring);
    const clawbacks: WireClawback[] = incoming.map((p) => ({
      direction: 'incoming',
      info: toWireClawbackInfo(p.info),
      coinIdHex: strip0x(chia.toHex(p.coin.coinId())),
    }));
    for (const wire of req.clawbackCandidates ?? []) {
      const info = fromWireClawbackInfo(wire);
      const coin = await findClawbackCoin(chia, deps.chain, info);
      if (coin) clawbacks.push({ direction: 'outgoing', info: toWireClawbackInfo(info), coinIdHex: strip0x(chia.toHex(coin.coinId())) });
    }
    return { success: true, clawbacks };
  }

  /**
   * Build the CLAIM (receiver) or CLAW BACK (sender) spend for one pending clawback (#152) and HOLD
   * it under a pending id — the SAME pending map + `confirmSend` broadcast path as a coin send. The
   * actor's own key must own the relevant side (`MISSING_KEY` otherwise); the coin must currently be
   * pending on chain (`NO_CLAWBACK_COIN` otherwise — already resolved, or not yet confirmed).
   */
  private async prepareClawbackAction(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia || !deps.chain) return { success: false, code: 'CHAIN_UNAVAILABLE', message: 'chain unavailable' };
    if (!req.clawbackInfo || !req.direction) return { success: false, code: 'BAD_REQUEST', message: 'clawbackInfo + direction required' };
    const keyring = await this.heldKeyring(deps, req.activeIndex);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const chia = deps.chia as unknown as ClawbackWasm;
    const info = fromWireClawbackInfo(req.clawbackInfo);
    const prepared = await buildClawbackAction(chia, deps.chain, { keyring, info, direction: req.direction, fee: BigInt(req.fee ?? '0') });
    const pendingId = crypto.randomUUID();
    const inputCoinIds = prepared.coinSpends.map((cs) => strip0x(chia.toHex(cs.coin.coinId())));
    // #154 — a claim/reclaim moves funds to the actor's OWN address (self-only); logged as kind
    // 'clawback' by the caller regardless of direction (see background/index.ts).
    const activityHint: ActivityHint = { asset: 'XCH', amount: prepared.amountOut.toString(), counterparty: null };
    this.pending.set(pendingId, { coinSpends: prepared.coinSpends, secretKeys: prepared.secretKeys, inputCoinIds, activityHint });
    return { success: true, pendingId, clawbackAmountOut: prepared.amountOut.toString() };
  }

  /**
   * Derive the wallet's HD keyring at the ACTIVE index (both schemes, §165) — the standard puzzle
   * hashes + synthetic public/secret keys a dApp request is decoded against and signed with.
   * Offscreen-only (holds the seed). Returns `null` when locked / no wasm.
   */
  private async heldKeyring(deps: VaultDeps, activeIndex?: number): Promise<ReturnType<typeof buildKeyring> | null> {
    if (!deps.chia) return null;
    const seed = await this.heldSeed();
    if (!seed) return null;
    return buildKeyring(deps.chia as unknown as SendFlowWasm, seed, { index: activeIndex ?? 0 });
  }

  /** The wallet's synthetic public keys (hex, deduped) — CHIP-0002 `getPublicKeys` for a dApp. */
  private async getPublicKeys(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!deps.chia) return { success: false, code: 'WASM_UNAVAILABLE', message: 'derivation unavailable' };
    if (!this.hasKey()) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const keyring = await this.heldKeyring(deps, req.activeIndex);
    if (!keyring) return { success: false, code: 'LOCKED', message: 'wallet is locked' };
    const publicKeys = [...new Set(keyring.map((k) => strip0x(deps.chia!.toHex(k.pk.toBytes()))))];
    return { success: true, publicKeys };
  }

  /**
   * The wallet's UNSPENT coins for one asset — XCH at the derived inner (p2) puzzle hashes, or a CAT
   * at its CAT puzzle hash (`catPuzzleHash(tail, innerPh)`) over the same inner hashes — both HD
   * schemes AT THE ACTIVE INDEX (§165). Asset routing is purely by `assetId` (undefined / `'xch'` =
   * native XCH; any other value = a CAT TAIL), the same rule the send flow uses (regression-guards
   * the #121 asset-drop). Returns `null` when locked / no wasm. Offscreen-only (derives from the
   * held seed).
   */
  private async heldAssetCoins(deps: VaultDeps, assetId?: string, activeIndex?: number): Promise<ChainCoin[] | null> {
    if (!deps.chia || !deps.chain) return null;
    const seed = await this.heldSeed();
    if (!seed) return null;
    const chia = deps.chia;
    const accounts = deriveAccounts(chia, seed, { schemes: ['unhardened', 'hardened'], start: activeIndex ?? 0, count: 1 });
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
    const coins = await this.heldAssetCoins(deps, req.assetId, req.activeIndex);
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
    const coins = await this.heldAssetCoins(deps, req.assetId, req.activeIndex);
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
    const keyring = await this.heldKeyring(deps, req.activeIndex);
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
    const keyring = await this.heldKeyring(deps, req.activeIndex);
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
    const keyring = await this.heldKeyring(deps, req.activeIndex);
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
