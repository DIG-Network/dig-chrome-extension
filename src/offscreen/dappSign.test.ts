import { describe, it, expect, beforeAll } from 'vitest';
import {
  reconstructCoinSpends,
  decodeDappSpend,
  signDappCoinSpends,
  signMessageCustody,
  type DappSignWasm,
  type WireCoinSpend,
} from './dappSign';
import { TESTNET11_AGG_SIG_ME, type SigCoinSpend, type SigSecretKey } from './signing';
import { loadChiaWasmNode } from '@/test/chiaWasm';

/**
 * The dApp foreign-spend decode + sign core (§5.5) — the tamper-resistant summary rendered in the
 * SW-summoned approval window and the sign performed on approval. Proven against the wasm Simulator
 * (a reconstructed signature is accepted by `newTransaction`), exactly like the §5.8 signing spike.
 */

interface TestWasm {
  fromHex(hex: string): Uint8Array;
  toHex(bytes: Uint8Array): string;
  Simulator: new () => {
    bls(amount: bigint): { sk: SigSecretKey; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown };
    newTransaction(bundle: unknown): void;
  };
  Clvm: new () => {
    delegatedSpend(conditions: unknown[]): unknown;
    createCoin(puzzleHash: Uint8Array, amount: bigint, memos: undefined): unknown;
    spendStandardCoin(coin: unknown, syntheticKey: { toBytes(): Uint8Array }, spend: unknown): void;
    coinSpends(): SigCoinSpend[];
  };
  SpendBundle: new (coinSpends: SigCoinSpend[], aggregatedSignature: unknown) => unknown;
  Signature: { fromBytes(bytes: Uint8Array): unknown };
  PublicKey: { fromBytes(bytes: Uint8Array): { verify(message: Uint8Array, sig: unknown): boolean } };
}

let chia: TestWasm;
const dw = (): DappSignWasm => chia as unknown as DappSignWasm;
const strip = (h: string): string => h.replace(/^0x/i, '').toLowerCase();

beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

/** Serialize wasm coin spends to the dApp wire shape (hex fields, like a page-supplied request). */
function toWire(coinSpends: SigCoinSpend[]): WireCoinSpend[] {
  return coinSpends.map((cs) => {
    const coin = cs.coin as unknown as { parentCoinInfo: Uint8Array; puzzleHash: Uint8Array; amount: bigint };
    return {
      coin: {
        parent_coin_info: chia.toHex(coin.parentCoinInfo),
        puzzle_hash: chia.toHex(coin.puzzleHash),
        amount: coin.amount.toString(),
      },
      puzzle_reveal: chia.toHex((cs as unknown as { puzzleReveal: Uint8Array }).puzzleReveal),
      solution: chia.toHex((cs as unknown as { solution: Uint8Array }).solution),
    };
  });
}

/** A self-send standard spend: input 1000 → CREATE_COIN 1000 back to the same (own) puzzle hash. */
function selfSpend() {
  const sim = new chia.Simulator();
  const pair = sim.bls(1000n);
  const clvm = new chia.Clvm();
  clvm.spendStandardCoin(pair.coin, pair.pk, clvm.delegatedSpend([clvm.createCoin(pair.puzzleHash, 1000n, undefined)]));
  return { sim, pair, wire: toWire(clvm.coinSpends()) };
}

describe('dappSign — reconstruct', () => {
  it('rebuilds wasm coin spends from snake_case wire (hex) coin spends', () => {
    const { wire } = selfSpend();
    const { coinSpends, inputs } = reconstructCoinSpends(dw(), wire);
    expect(coinSpends).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].amount).toBe(1000n);
    // The reconstructed coin id is deterministic from parent‖ph‖amount.
    expect(inputs[0].coinIdHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dappSign — decode summary (tamper-resistant, from the built spend)', () => {
  it('classifies a self-send: one self input + one self output, zero fee', () => {
    const { pair, wire } = selfSpend();
    const ownPh = [strip(chia.toHex(pair.puzzleHash))];
    const ownPk = [strip(chia.toHex(pair.pk.toBytes()))];
    const s = decodeDappSpend(dw(), wire, ownPh, TESTNET11_AGG_SIG_ME, ownPk);
    expect(s.coinCount).toBe(1);
    expect(s.inputs[0].isSelf).toBe(true);
    expect(s.inputs[0].amount).toBe('1000');
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].isSelf).toBe(true);
    expect(s.changeMojos).toBe('1000');
    expect(s.sendingMojos).toBe('0');
    expect(s.feeMojos).toBe('0');
    expect(s.allInputsSelf).toBe(true);
    expect(s.requiredSigners).toHaveLength(1);
    expect(s.requiredSigners[0]).toBe(ownPk[0]);
    expect(s.ownedSigners).toBe(1);
  });

  it('classifies an outgoing send: output to a stranger is not self, fee = inputs − outputs', () => {
    const sim = new chia.Simulator();
    const me = sim.bls(1000n);
    const strangerPh = sim.bls(1n).puzzleHash; // a different puzzle hash we do NOT own
    const clvm = new chia.Clvm();
    clvm.spendStandardCoin(
      me.coin,
      me.pk,
      clvm.delegatedSpend([
        clvm.createCoin(strangerPh, 400n, undefined), // sent
        clvm.createCoin(me.puzzleHash, 590n, undefined), // change to self (10 mojo fee)
      ]),
    );
    const wire = toWire(clvm.coinSpends());
    const ownPh = [strip(chia.toHex(me.puzzleHash))];
    const s = decodeDappSpend(dw(), wire, ownPh, TESTNET11_AGG_SIG_ME);
    expect(s.sendingMojos).toBe('400');
    expect(s.changeMojos).toBe('590');
    expect(s.feeMojos).toBe('10');
    const stranger = s.outputs.find((o) => !o.isSelf);
    expect(stranger?.amount).toBe('400');
  });
});

describe('dappSign — sign (proven consensus-valid)', () => {
  it('signs a foreign spend into a signature the Simulator accepts', () => {
    const { sim, pair, wire } = selfSpend();
    const { signatureHex } = signDappCoinSpends(dw(), wire, [pair.sk], TESTNET11_AGG_SIG_ME);
    expect(signatureHex).toMatch(/^[0-9a-f]{192}$/); // 96-byte BLS signature
    const { coinSpends } = reconstructCoinSpends(dw(), wire);
    const bundle = new chia.SpendBundle(coinSpends, chia.Signature.fromBytes(chia.fromHex(signatureHex)));
    expect(() => sim.newTransaction(bundle)).not.toThrow();
  });

  it('throws MISSING_KEY when the wallet does not hold a required signer', () => {
    const { wire } = selfSpend();
    const s = new chia.Simulator();
    s.bls(1n);
    const other = s.bls(1n).sk; // a distinct key that did not sign this spend
    expect(() => signDappCoinSpends(dw(), wire, [other], TESTNET11_AGG_SIG_ME)).toThrow(/MISSING_KEY/);
  });
});

describe('dappSign — message signing', () => {
  it('signs a message with the matching key; the signature verifies under its public key', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1n);
    const message = new TextEncoder().encode('hello dig');
    const { signatureHex, publicKeyHex } = signMessageCustody(dw(), message, [pair.sk]);
    expect(publicKeyHex).toMatch(/^[0-9a-f]{96}$/);
    const pk = chia.PublicKey.fromBytes(chia.fromHex(publicKeyHex));
    expect(pk.verify(message, chia.Signature.fromBytes(chia.fromHex(signatureHex)))).toBe(true);
  });

  it('signs under a requested public key when the wallet owns it', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1n);
    const pkHex = strip(chia.toHex(pair.pk.toBytes()));
    const message = new TextEncoder().encode('sign as me');
    const { publicKeyHex } = signMessageCustody(dw(), message, [pair.sk], pkHex);
    expect(publicKeyHex).toBe(pkHex);
  });

  it('throws MISSING_KEY when asked to sign under a key the wallet does not own', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1n);
    // The simulator is deterministic; advance past the first key to a genuinely distinct one.
    const other = new chia.Simulator();
    other.bls(1n);
    const strangerPk = strip(chia.toHex(other.bls(1n).pk.toBytes()));
    const message = new TextEncoder().encode('x');
    expect(() => signMessageCustody(dw(), message, [pair.sk], strangerPk)).toThrow(/MISSING_KEY/);
  });
});
