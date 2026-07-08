import { describe, it, expect, beforeAll } from 'vitest';
import { buildXchSend, type SendWasm, type KeyPair } from './send';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm, type SigSecretKey } from './signing';
import { loadChiaWasmNode } from '@/test/chiaWasm';

/**
 * XCH send construction proven consensus-valid against the wasm Simulator: build → sign → the
 * Simulator accepts the bundle. Never broadcasts a real spend.
 */
interface TestWasm {
  toHex(b: Uint8Array): string;
  Simulator: new () => {
    bls(amount: bigint): { sk: SigSecretKey; pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array; coin: unknown };
    newTransaction(bundle: unknown): void;
    createBlock(): void;
  };
  SpendBundle: new (coinSpends: unknown, sig: unknown) => unknown;
}

let chia: TestWasm;
const asSend = () => chia as unknown as SendWasm;
const asSig = () => chia as unknown as SigningWasm;
beforeAll(async () => {
  chia = (await loadChiaWasmNode()) as unknown as TestWasm;
});

function keyMap(pair: { pk: { toBytes(): Uint8Array }; puzzleHash: Uint8Array }): Map<string, KeyPair> {
  return new Map([[chia.toHex(pair.puzzleHash).replace(/^0x/i, '').toLowerCase(), { pk: pair.pk } as KeyPair]]);
}

describe('buildXchSend', () => {
  it('builds a send whose signed bundle the Simulator accepts, with a decoded summary', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n); // 1 XCH
    const dest = new Uint8Array(32).fill(9);
    const built = buildXchSend(asSend(), {
      coins: [pair.coin as never],
      keyByPuzzleHash: keyMap(pair),
      destPuzzleHash: dest,
      amount: 250_000_000_000n,
      fee: 1_000_000n,
      changePuzzleHash: pair.puzzleHash,
    });
    expect(built.summary.sent).toBe('250000000000');
    expect(built.summary.fee).toBe('1000000');
    expect(built.summary.change).toBe('749999000000'); // 1 XCH − sent − fee
    expect(built.summary.recipientPuzzleHashHex).toBe(chia.toHex(dest).replace(/^0x/i, '').toLowerCase());

    const sig = signCoinSpends(asSig(), built.coinSpends, [pair.sk], TESTNET11_AGG_SIG_ME);
    const bundle = new chia.SpendBundle(built.coinSpends, sig);
    expect(() => {
      sim.newTransaction(bundle);
      sim.createBlock();
    }).not.toThrow();
  });

  it('throws MISSING_KEY when a selected coin is not owned by the wallet', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n);
    expect(() =>
      buildXchSend(asSend(), {
        coins: [pair.coin as never],
        keyByPuzzleHash: new Map(), // no keys → can't provide the inner spend
        destPuzzleHash: new Uint8Array(32).fill(9),
        amount: 1000n,
        fee: 0n,
        changePuzzleHash: pair.puzzleHash,
      }),
    ).toThrow(/MISSING_KEY/);
  });

  /**
   * #105 — an optional memo attached to a send is decoded back FROM THE BUILT SPEND (never just
   * echoed from caller input, §5.5) so the review step shows exactly what will land on chain. A
   * plain-text memo is a SINGLE-atom CREATE_COIN memo list — distinct from clawback's 2-element
   * `[receiverPuzzleHash, clawback.memo()]` list, so the two never get cross-decoded.
   */
  it('decodes an optional memo back from the built CREATE_COIN (#105)', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n);
    const dest = new Uint8Array(32).fill(9);
    const memoText = 'for pizza \u{1F355}';
    // #105 gotcha: `TextEncoder().encode()` can fail the wasm boundary's `instanceof Uint8Array`
    // check under Vitest/jsdom (a cross-realm typed array) — normalize with `Uint8Array.from`.
    const memoBytes = Uint8Array.from(new TextEncoder().encode(memoText));
    const built = buildXchSend(asSend(), {
      coins: [pair.coin as never],
      keyByPuzzleHash: keyMap(pair),
      destPuzzleHash: dest,
      amount: 250_000_000_000n,
      fee: 0n,
      changePuzzleHash: pair.puzzleHash,
      buildMemos: (clvm) => (clvm as { alloc(items: unknown[]): unknown }).alloc([memoBytes]),
    });
    expect(built.summary.memoText).toBe(memoText);

    const sig = signCoinSpends(asSig(), built.coinSpends, [pair.sk], TESTNET11_AGG_SIG_ME);
    const bundle = new chia.SpendBundle(built.coinSpends, sig);
    expect(() => {
      sim.newTransaction(bundle);
      sim.createBlock();
    }).not.toThrow();
  });

  it('omits memoText when no memo was built', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n);
    const built = buildXchSend(asSend(), {
      coins: [pair.coin as never],
      keyByPuzzleHash: keyMap(pair),
      destPuzzleHash: new Uint8Array(32).fill(9),
      amount: 1000n,
      fee: 0n,
      changePuzzleHash: pair.puzzleHash,
    });
    expect(built.summary.memoText).toBeUndefined();
  });

  it('handles a send with no change (exact amount minus fee)', () => {
    const sim = new chia.Simulator();
    const pair = sim.bls(1_000_000_000_000n);
    const dest = new Uint8Array(32).fill(7);
    const built = buildXchSend(asSend(), {
      coins: [pair.coin as never],
      keyByPuzzleHash: keyMap(pair),
      destPuzzleHash: dest,
      amount: 999_999_000_000n, // 1 XCH − fee, no change
      fee: 1_000_000n,
      changePuzzleHash: pair.puzzleHash,
    });
    expect(built.summary.sent).toBe('999999000000');
    expect(built.summary.change).toBe('0');
    const sig = signCoinSpends(asSig(), built.coinSpends, [pair.sk], TESTNET11_AGG_SIG_ME);
    expect(() => {
      sim.newTransaction(new chia.SpendBundle(built.coinSpends, sig));
      sim.createBlock();
    }).not.toThrow();
  });
});
