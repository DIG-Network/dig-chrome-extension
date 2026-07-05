/**
 * Send flow orchestration (§6 Send) — the link between the wallet's keys/coins and the pure spend
 * builder. Runs in the offscreen vault (holds the seed). Derives the HD keyring (both schemes),
 * fetches the wallet's unspent coins, builds the XCH spend + decoded summary (`send.ts`), and — on
 * a separate approved step — signs + bundles (`signing.ts`). Broadcasting is the caller's approved
 * step. Pure (injected wasm + chain); proven consensus-valid against the wasm simulator.
 */

import { buildXchSend, type SendWasm, type KeyPair, type SpendSummary } from '@/offscreen/send';
import { signCoinSpends, type SigningWasm, type SigSecretKey, type SigCoinSpend } from '@/offscreen/signing';
import type { ChainClient, ChainSpendBundle } from '@/offscreen/chain';
import { WALLET_PATH_PREFIX, type Scheme } from '@/lib/keystore/derive';

/** A wasm secret key with the derivation + signing surface the flow needs. */
interface FullSecretKey extends SigSecretKey {
  deriveUnhardenedPath(path: number[]): FullSecretKey;
  deriveHardenedPath(path: number[]): FullSecretKey;
  deriveSynthetic(): FullSecretKey;
  publicKey(): KeyPair['pk'];
}

/**
 * The wasm surface the send flow needs (derivation + address decode + bundle + build + sign).
 * Extends `SendWasm` only — `SigningWasm` types `Clvm.deserialize`'s Program differently, so the
 * signer receives a cast in `signAndBundle` rather than a conflicting intersection here.
 */
export interface SendFlowWasm extends SendWasm {
  SecretKey: { fromSeed(seed: Uint8Array): FullSecretKey };
  standardPuzzleHash(syntheticKey: KeyPair['pk']): Uint8Array;
  fromHex(hex: string): Uint8Array;
  Signature: { aggregate(signatures: unknown[]): unknown };
  Address: { decode(address: string): { puzzleHash: Uint8Array; free?(): void } };
  SpendBundle: new (coinSpends: SigCoinSpend[], signature: unknown) => ChainSpendBundle;
}

/** One derived signing slot: its standard puzzle hash + the synthetic public + secret key. */
export interface KeyringEntry {
  puzzleHashHex: string;
  pk: KeyPair['pk'];
  sk: SigSecretKey;
}

const strip0x = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

/** Derive the HD keyring (both schemes to `count`): standard puzzle hash → synthetic keys. */
export function buildKeyring(
  chia: SendFlowWasm,
  seed: Uint8Array,
  opts: { schemes?: Scheme[]; count: number },
): KeyringEntry[] {
  const schemes = opts.schemes ?? (['unhardened', 'hardened'] as Scheme[]);
  const master = chia.SecretKey.fromSeed(seed);
  try {
    const out: KeyringEntry[] = [];
    for (const scheme of schemes) {
      for (let i = 0; i < opts.count; i++) {
        const path = [...WALLET_PATH_PREFIX, i];
        const account = scheme === 'hardened' ? master.deriveHardenedPath(path) : master.deriveUnhardenedPath(path);
        const sk = account.deriveSynthetic();
        account.free?.();
        const pk = sk.publicKey();
        out.push({ puzzleHashHex: strip0x(chia.toHex(chia.standardPuzzleHash(pk))), pk, sk });
      }
    }
    return out;
  } finally {
    master.free?.();
  }
}

/** A prepared (unsigned) XCH send: coin spends, the decoded summary, and the keys to sign with. */
export interface PreparedSend {
  coinSpends: SigCoinSpend[];
  summary: SpendSummary;
  secretKeys: SigSecretKey[];
}

/**
 * Prepare an XCH send: derive the keyring, fetch the wallet's unspent coins, decode the recipient,
 * and build the spend + summary. Does NOT sign or broadcast. Change returns to index-0 unhardened.
 */
export async function prepareXchSend(
  chia: SendFlowWasm,
  chain: ChainClient,
  opts: { seed: Uint8Array; recipient: string; amount: bigint; fee: bigint; gapLimit?: number },
): Promise<PreparedSend> {
  const keyring = buildKeyring(chia, opts.seed, { count: opts.gapLimit ?? 20 });
  const keyByPuzzleHash = new Map<string, KeyPair>(keyring.map((k) => [k.puzzleHashHex, { pk: k.pk }]));
  const coins = await chain.unspentCoins(keyring.map((k) => k.puzzleHashHex));
  const destPuzzleHash = chia.Address.decode(opts.recipient).puzzleHash;
  const changePuzzleHash = chia.fromHex(keyring[0].puzzleHashHex);
  const built = buildXchSend(chia, {
    coins,
    keyByPuzzleHash,
    destPuzzleHash,
    amount: opts.amount,
    fee: opts.fee,
    changePuzzleHash,
  });
  return { coinSpends: built.coinSpends, summary: built.summary, secretKeys: keyring.map((k) => k.sk) };
}

/** Sign a prepared send and return the broadcastable SpendBundle (the approved, final step). */
export function signAndBundle(
  chia: SendFlowWasm,
  coinSpends: SigCoinSpend[],
  secretKeys: SigSecretKey[],
  additionalDataHex: string,
): ChainSpendBundle {
  // SendWasm + SigningWasm both type Clvm.deserialize's Program differently; cast for the signer.
  const sig = signCoinSpends(chia as unknown as SigningWasm, coinSpends, secretKeys, additionalDataHex);
  return new chia.SpendBundle(coinSpends, sig);
}
