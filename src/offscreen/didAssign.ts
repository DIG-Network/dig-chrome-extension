/**
 * Assign a wallet-owned DID as an NFT's owner (#93) — the CHIP-0011 ownership-layer bonding: the NFT
 * emits a `TransferNft` condition (opcode -10) naming the DID's launcher id + its CURRENT inner
 * puzzle hash; the ownership layer automatically creates a matching puzzle announcement the DID must
 * assert, and the DID creates its own announcement (the NFT's launcher id) the ownership layer
 * checks — both spent in ONE bundle, so the "handshake" is atomic. Mirrors chia-sdk-driver's
 * `Nft::assign_owner` + `UpdateNftAction` EXACTLY (byte-identical `assignment_puzzle_announcement_id`
 * construction — verified against xch-dev/chia-wallet-sdk
 * crates/chia-sdk-driver/src/primitives/nft.rs + actions/update_nft.rs):
 *
 *   announcement_id = sha256(nft's CURRENT full puzzle hash ‖ 0xAD 0x4C ‖
 *                             treeHash(list(didLauncherId, [], didInnerPuzzleHash)))
 *
 * chia-wallet-sdk-wasm 0.33 exposes NO `Spends.addDid` / high-level `Action` helper for this (the
 * rust driver's own `Spends` struct DOES track DIDs internally, but the wasm bindings — confirmed
 * against `crates/chia-sdk-bindings/src/action_system.rs` at HEAD — never expose a way to add one),
 * so — like DID create/transfer/profile-update — it is built from the lower-level
 * `Clvm.spendNft`/`spendDid` primitives directly. Does NOT change custody (the NFT + DID both stay
 * with this wallet, same p2 puzzle hashes) — only the NFT's `currentOwner` field changes, which IS
 * immediately observable by a naive chain rescan (the `TransferNft` condition carries the new owner
 * in plaintext in the p2 spend's output conditions — unlike DID metadata, it is not curried-only; see
 * `dids.ts`'s `prepareDidProfileUpdate` for the contrasting case that needs a two-spend "settle").
 * Does NOT sign or broadcast — the vault's confirm step does that on explicit user approval.
 */

import { buildKeyring, type SendFlowWasm } from '@/offscreen/sendFlow';
import { type SigCoinSpend, type SigSecretKey } from '@/offscreen/signing';
import type { ChainClient } from '@/offscreen/chain';
import { findOwnedNft, type NftWasm, type NftObj, type NftClvm } from '@/offscreen/nfts';
import { findOwnedDid, payFeeFromSeparateCoin, type DidWasm, type DidClvm } from '@/offscreen/dids';

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** A CLVM `Program`-like handle this module needs beyond the narrow NFT/DID surfaces. */
interface AssignProgram {
  treeHash(): Uint8Array;
}
interface AssignClvm {
  alloc(value: unknown): AssignProgram;
  createCoin(puzzleHash: Uint8Array, amount: bigint, memos?: unknown): unknown;
  standardSpend(syntheticKey: unknown, spend: unknown): unknown;
  delegatedSpend(conditions: unknown[]): unknown;
  coinSpends(): SigCoinSpend[];
  spendNft(nft: NftObj, innerSpend: unknown): NftObj | undefined;
  spendDid(did: unknown, innerSpend: unknown): unknown;
  assertPuzzleAnnouncement(announcementId: Uint8Array): unknown;
  createPuzzleAnnouncement(message: Uint8Array): unknown;
}

/**
 * The full wasm surface this module needs. Standalone (NOT `extends NftWasm, DidWasm` — those each
 * type `Clvm` narrowly for their OWN reconstruction needs, e.g. `deserialize(...): NftProgram` vs
 * `DidProgram`; a single real `Clvm` instance satisfies all three simultaneously, but the TS
 * inheritance graph doesn't need to prove that — call sites into `nfts.ts`/`dids.ts` cast explicitly,
 * per this codebase's established per-file narrow-cast convention (see `nfts.ts`/`dids.ts` headers).
 */
export interface AssignWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Clvm: new () => AssignClvm;
  /** The CHIP-0011 NFT ownership-transfer condition (opcode -10): `(launcherId tradePrices innerPuzzleHash)`. */
  TransferNft: new (launcherId: Uint8Array | undefined, tradePrices: unknown[], singletonInnerPuzzleHash?: Uint8Array) => unknown;
  sha256(value: Uint8Array): Uint8Array;
}

const asHex = (chia: AssignWasm, b: Uint8Array): string => strip0x(chia.toHex(b));

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * The announcement id the DID must assert (and whose creation the NFT's ownership layer relies on
 * automatically) — byte-identical to `chia_sdk_driver::assignment_puzzle_announcement_id`.
 */
function assignmentPuzzleAnnouncementId(
  chia: AssignWasm,
  clvm: AssignClvm,
  nftFullPuzzleHash: Uint8Array,
  didLauncherId: Uint8Array,
  didInnerPuzzleHash: Uint8Array,
): Uint8Array {
  const argsList = clvm.alloc([didLauncherId, [], didInnerPuzzleHash]);
  const magic = new Uint8Array([0xad, 0x4c]);
  return chia.sha256(concatBytes(nftFullPuzzleHash, magic, argsList.treeHash()));
}

/** A prepared (unsigned) NFT↔DID assignment: coin spends + the keys to sign + the decoded summary. */
export interface PreparedNftDidAssign {
  coinSpends: SigCoinSpend[];
  secretKeys: SigSecretKey[];
  summary: NftDidAssignSummary;
}
/** The decoded, tamper-resistant summary of an NFT↔DID assignment for the user to approve. */
export interface NftDidAssignSummary {
  nftLauncherId: string;
  didLauncherId: string;
  fee: string;
  coinCount: number;
}

/**
 * Prepare (build, don't sign/broadcast) assigning the wallet's DID `didLauncherId` as the OWNER of
 * the wallet's NFT `nftLauncherId` — both must already be held by this wallet. Neither the NFT's nor
 * the DID's custody (p2 puzzle hash) changes; only the NFT's on-chain `currentOwner` field is set. A
 * `fee` (XCH), when given, is paid from a SEPARATE wallet-owned XCH coin (both the NFT and DID coins
 * carry only 1 mojo each). Throws `NFT_NOT_FOUND` / `DID_NOT_FOUND` if either is not held.
 */
export async function prepareNftDidAssign(
  chia: AssignWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; nftLauncherId: string; didLauncherId: string; fee?: bigint; gapLimit?: number },
): Promise<PreparedNftDidAssign> {
  const fee = opts.fee ?? 0n;
  const keyring = buildKeyring(chia as unknown as SendFlowWasm, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map(keyring.map((k) => [k.puzzleHashHex, k]));
  const ownedPhs = new Set(keyring.map((k) => k.puzzleHashHex));
  // ONE shared Clvm allocator: the reconstructed NFT's metadata Program + the DID handle must live in
  // the SAME arena as the spends that consume them (cross-arena wasm handles trap).
  const clvm = new chia.Clvm();

  const nft = await findOwnedNft(chia as unknown as NftWasm, chain, clvm as unknown as NftClvm, keyring, opts.nftLauncherId);
  const did = await findOwnedDid(chia as unknown as DidWasm, chain, clvm as unknown as DidClvm, ownedPhs, opts.didLauncherId);

  const nftOwnerKey = keyByPuzzleHash.get(asHex(chia, nft.info.p2PuzzleHash));
  if (!nftOwnerKey) throw new Error('MISSING_KEY: the NFT owner key is not held by this wallet');
  const didOwnerKey = keyByPuzzleHash.get(asHex(chia, did.info.p2PuzzleHash));
  if (!didOwnerKey) throw new Error('MISSING_KEY: the DID owner key is not held by this wallet');

  const didInnerPuzzleHash = did.info.innerPuzzleHash();
  const transferCondition = new chia.TransferNft(did.info.launcherId, [], didInnerPuzzleHash);

  // NFT: keep the same p2 owner (custody unchanged); emit the ownership-transfer condition.
  const nftHint = clvm.alloc([nft.info.p2PuzzleHash]);
  clvm.spendNft(
    nft,
    clvm.standardSpend(
      nftOwnerKey.pk,
      clvm.delegatedSpend([clvm.createCoin(nft.info.p2PuzzleHash, nft.coin.amount, nftHint), clvm.alloc(transferCondition)]),
    ),
  );

  const announcementId = assignmentPuzzleAnnouncementId(chia, clvm, nft.coin.puzzleHash, did.info.launcherId, didInnerPuzzleHash);

  const feeKeys = await payFeeFromSeparateCoin(chain, clvm as unknown as DidClvm, keyByPuzzleHash, keyring, (b) => asHex(chia, b), fee);
  const secretKeys: SigSecretKey[] = [nftOwnerKey.sk, didOwnerKey.sk, ...feeKeys];

  // DID: recreate itself unchanged (custody + metadata both stay put), assert the NFT's automatic
  // announcement, and create the announcement the NFT's ownership layer expects in return.
  const didHint = clvm.alloc([did.info.p2PuzzleHash]);
  clvm.spendDid(
    did,
    clvm.standardSpend(
      didOwnerKey.pk,
      clvm.delegatedSpend([
        clvm.createCoin(didInnerPuzzleHash, did.coin.amount, didHint),
        clvm.assertPuzzleAnnouncement(announcementId),
        clvm.createPuzzleAnnouncement(nft.info.launcherId),
      ]),
    ),
  );

  const coinSpends = clvm.coinSpends();
  return {
    coinSpends,
    secretKeys,
    summary: {
      nftLauncherId: strip0x(opts.nftLauncherId),
      didLauncherId: strip0x(opts.didLauncherId),
      fee: fee.toString(),
      coinCount: coinSpends.length,
    },
  };
}
