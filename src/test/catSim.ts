/**
 * Shared test helpers to mint + hint-transfer a CAT inside the wasm Simulator, so both the CAT
 * discovery unit test and the balance-scan integration test can create a genuinely held, genuinely
 * hinted CAT without duplicating the driver dance. Test-only (src/test/** is coverage-excluded).
 * Never broadcasts — the Simulator validates each bundle in-process.
 */
import { buildKeyring, reconstructCats, type SendFlowWasm } from '@/offscreen/sendFlow';
import { signCoinSpends, TESTNET11_AGG_SIG_ME, type SigningWasm } from '@/offscreen/signing';
import type { ChainClient, ChainCoin, ChainCoinSpend, ChainSpendBundle } from '@/offscreen/chain';

export interface SimHandle {
  newCoin(puzzleHash: Uint8Array, amount: bigint): ChainCoin;
  newTransaction(bundle: ChainSpendBundle): void;
  createBlock(): void;
  unspentCoins(puzzleHash: Uint8Array, includeHints: boolean): ChainCoin[];
  coinSpend(coinId: Uint8Array): ChainCoinSpend | undefined;
}

/** The wasm surface the CAT sim helpers drive (beyond SendFlowWasm's derivation/codec surface). */
export interface CatSimWasm {
  toHex(bytes: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  Simulator: new () => SimHandle;
  Clvm: new () => {
    alloc(value: unknown): unknown;
    delegatedSpend(conditions: unknown[]): unknown;
    standardSpend(pk: unknown, spend: unknown): unknown;
    coinSpends(): ChainCoinSpend[];
  };
  Spends: new (
    clvm: unknown,
    changePh: Uint8Array,
  ) => {
    addXch(coin: unknown): void;
    addCat(cat: unknown): void;
    apply(actions: unknown[]): unknown;
    prepare(deltas: unknown): {
      pendingSpends(): Array<{ coin(): { coinId(): Uint8Array }; p2PuzzleHash(): Uint8Array; conditions(): unknown[] }>;
      insert(id: Uint8Array, s: unknown): void;
      spend(): { cats(): unknown[]; cat(id: unknown): Array<{ info: { assetId: Uint8Array } }> };
    };
  };
  Action: { singleIssueCat(hidden: undefined, amount: bigint): unknown; send(id: unknown, ph: Uint8Array, amount: bigint, memos: unknown): unknown };
  Id: { existing(assetId: Uint8Array): unknown };
  SpendBundle: new (coinSpends: unknown, signature: unknown) => ChainSpendBundle;
}

type Ring = ReturnType<typeof buildKeyring>;

const hx = (chia: CatSimWasm, b: Uint8Array): string => chia.toHex(b).replace(/^0x/i, '').toLowerCase();

/** A sim-backed chain client covering hint discovery (unspent by puzzle hash OR hint). */
export function simChain(chia: CatSimWasm, sim: SimHandle): ChainClient {
  return {
    totalUnspent: async () => 0,
    unspentCoins: async (phs) => phs.flatMap((h) => sim.unspentCoins(chia.fromHex(h), false)),
    coinRecords: async () => [],
    getCoinSpend: async (idHex) => sim.coinSpend(chia.fromHex(idHex)) ?? null,
    pushSpendBundle: async (bundle) => {
      sim.newTransaction(bundle);
      sim.createBlock();
      return { success: true };
    },
    coinConfirmed: async () => true,
    coinsByHints: async (hints) => hints.flatMap((h) => sim.unspentCoins(chia.fromHex(h), true)),
  };
}

/** Issue `amount` of a single-issuance CAT to `ring[0]` (funded by XCH already at ring[0]). Returns the tail. */
export function issueCatTo(chia: CatSimWasm, sig: SigningWasm, sim: SimHandle, ring: Ring, amount: bigint): string {
  const ph0 = chia.fromHex(ring[0].puzzleHashHex);
  const clvm = new chia.Clvm();
  const spends = new chia.Spends(clvm, ph0);
  spends.addXch(sim.unspentCoins(ph0, false)[0]);
  const finished = spends.prepare(spends.apply([chia.Action.singleIssueCat(undefined, amount)]));
  for (const ps of finished.pendingSpends()) finished.insert(ps.coin().coinId(), clvm.standardSpend(ring[0].pk, clvm.delegatedSpend(ps.conditions())));
  const outputs = finished.spend();
  const assetIdHex = hx(chia, (outputs.cat(outputs.cats()[0])[0] as { info: { assetId: Uint8Array } }).info.assetId);
  const issueSpends = clvm.coinSpends();
  sim.newTransaction(new chia.SpendBundle(issueSpends, signCoinSpends(sig, issueSpends, [ring[0].sk], TESTNET11_AGG_SIG_ME)));
  sim.createBlock();
  return assetIdHex;
}

/** Transfer the whole issued CAT from ring[0] to `destPhHex`, carrying the recipient hint (as a real send does). */
export async function transferCatHinted(
  chia: CatSimWasm,
  sig: SigningWasm,
  sim: SimHandle,
  ring: Ring,
  assetIdHex: string,
  destPhHex: string,
  amount: bigint,
): Promise<void> {
  const chain = simChain(chia, sim);
  const cats = await reconstructCats(chia as unknown as SendFlowWasm, chain, ring, assetIdHex);
  const clvm = new chia.Clvm();
  const destPh = chia.fromHex(destPhHex);
  const spends = new chia.Spends(clvm, chia.fromHex(ring[0].puzzleHashHex));
  for (const c of cats) spends.addCat(c);
  const hintMemo = clvm.alloc([destPh]); // recipient p2 as the create-coin hint (standard CAT detection)
  const sendAction = chia.Action.send(chia.Id.existing(chia.fromHex(assetIdHex)), destPh, amount, hintMemo);
  const finished = spends.prepare(spends.apply([sendAction]));
  const keyByPh = new Map(ring.map((k) => [k.puzzleHashHex, k.pk]));
  for (const ps of finished.pendingSpends()) {
    finished.insert(ps.coin().coinId(), clvm.standardSpend(keyByPh.get(hx(chia, ps.p2PuzzleHash())), clvm.delegatedSpend(ps.conditions())));
  }
  finished.spend();
  const sendSpends = clvm.coinSpends();
  sim.newTransaction(new chia.SpendBundle(sendSpends, signCoinSpends(sig, sendSpends, ring.map((k) => k.sk), TESTNET11_AGG_SIG_ME)));
  sim.createBlock();
}
