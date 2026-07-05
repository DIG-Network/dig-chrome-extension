/**
 * Tests for the dApp `walletRpc` custody router + approval queue (dapp-approval.mjs).
 *
 * This is the SW-side decision core behind the SW-summoned approval window (#56 §5.5):
 *   - per-origin consent gate (connect → pending until approved; other methods require connected),
 *   - read methods route straight to the offscreen vault (no approval),
 *   - sign/message methods ENQUEUE + summon the approval window, and the request promise resolves
 *     only when the window returns a decision (approve → vault signs; reject → error),
 *   - the queue drains as decisions land.
 *
 * Pure (chrome-free): the vault call, consent lookups, and window summon are injected deps.
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DappApprovalManager, classifyCustodyMethod } from '../dapp-approval.mjs';

const ORIGIN = 'https://dapp.example';

/** A manager wired with in-memory fakes; `vault` maps a vault op → its canned response. */
function makeManager({ approved = new Set([ORIGIN]), vault = {} } = {}) {
  const calls = { vault: [], summon: 0, pending: [] };
  let n = 0;
  const deps = {
    isOriginApproved: async (o) => approved.has(o),
    recordPendingOrigin: async (o) => { calls.pending.push(o); },
    callVault: async (req) => {
      calls.vault.push(req);
      const fn = vault[req.op];
      return fn ? fn(req) : { success: false, code: 'NO_STUB', message: req.op };
    },
    summonWindow: async () => { calls.summon++; },
    randomId: () => `id-${++n}`,
    gapLimit: 5,
  };
  return { m: new DappApprovalManager(deps), calls, deps };
}

const WIRE_COIN_SPENDS = [{ coin: { parent_coin_info: 'aa', puzzle_hash: 'bb', amount: '1000' }, puzzle_reveal: 'cc', solution: 'dd' }];

test('classifyCustodyMethod buckets the wallet surface', () => {
  assert.equal(classifyCustodyMethod('connect'), 'connect');
  assert.equal(classifyCustodyMethod('chip0002_connect'), 'connect');
  assert.equal(classifyCustodyMethod('getPublicKeys'), 'read');
  assert.equal(classifyCustodyMethod('chia_getAddress'), 'read');
  assert.equal(classifyCustodyMethod('chip0002_chainId'), 'read');
  assert.equal(classifyCustodyMethod('signCoinSpends'), 'sign');
  assert.equal(classifyCustodyMethod('signMessage'), 'message');
  assert.equal(classifyCustodyMethod('signMessageByAddress'), 'message');
  assert.equal(classifyCustodyMethod('createOffer'), 'unsupported'); // known method, not wired to custody yet
  assert.equal(classifyCustodyMethod('totallyMadeUp'), 'unknown');
});

test('connect: an unapproved origin gets 202 pending + is recorded (never auto-approved)', async () => {
  const { m, calls } = makeManager({ approved: new Set() });
  const env = await m.route({ method: 'connect', params: {}, origin: ORIGIN });
  assert.equal(env.status, 202);
  assert.deepEqual(calls.pending, [ORIGIN]);
  assert.equal(calls.summon, 0);
});

test('connect: an approved + unlocked origin gets the wallet address', async () => {
  const { m } = makeManager({ vault: { getReceiveAddress: () => ({ success: true, address: 'xch1abc' }) } });
  const env = await m.route({ method: 'connect', params: {}, origin: ORIGIN });
  assert.equal(env.status, 200);
  assert.equal(env.body.data.address, 'xch1abc');
});

test('connect: approved but locked → 4001-class error (unlock required)', async () => {
  const { m } = makeManager({ vault: { getReceiveAddress: () => ({ success: false, code: 'LOCKED' }) } });
  const env = await m.route({ method: 'connect', params: {}, origin: ORIGIN });
  assert.equal(env.status, 401);
});

test('a non-connected origin cannot call read or sign methods', async () => {
  const { m, calls } = makeManager({ approved: new Set() });
  const read = await m.route({ method: 'getPublicKeys', params: {}, origin: ORIGIN });
  assert.equal(read.status, 401);
  const sign = await m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  assert.equal(sign.status, 401);
  assert.equal(calls.summon, 0); // never summoned for an unconnected origin
});

test('read: getPublicKeys routes to the vault (no approval window)', async () => {
  const { m, calls } = makeManager({ vault: { getPublicKeys: () => ({ success: true, publicKeys: ['ab', 'cd'] }) } });
  const env = await m.route({ method: 'getPublicKeys', params: {}, origin: ORIGIN });
  assert.equal(env.status, 200);
  assert.deepEqual(env.body.data, ['ab', 'cd']);
  assert.equal(calls.summon, 0);
});

test('sign: signCoinSpends enqueues, summons the window, and resolves on approve', async () => {
  const { m, calls } = makeManager({
    vault: {
      decodeDappSpend: () => ({ success: true, dappSummary: { coinCount: 1, allInputsSelf: true, feeMojos: '0', sendingMojos: '0', changeMojos: '1000', inputs: [], outputs: [], requiredSigners: ['ab'], ownedSigners: 1 } }),
      signDappSpend: () => ({ success: true, signature: 'f'.repeat(192) }),
    },
  });
  // route() stays pending until a decision; capture the promise.
  const p = m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  await Promise.resolve();
  assert.equal(calls.summon, 1, 'window summoned once');
  assert.equal(m.size(), 1);

  // The window enriches summaries (decode from the built spend) then lists.
  await m.enrich();
  const items = m.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].origin, ORIGIN);
  assert.equal(items[0].kind, 'signCoinSpends');
  assert.equal(items[0].summary.changeMojos, '1000');

  const ack = await m.resolve(items[0].id, true);
  assert.equal(ack.remaining, 0);
  const env = await p;
  assert.equal(env.status, 200);
  assert.equal(env.body.data, 'f'.repeat(192)); // the aggregated signature
  assert.equal(m.size(), 0, 'queue drained');
});

test('sign: reject resolves the request with an error and drains the queue', async () => {
  const { m } = makeManager({ vault: { decodeDappSpend: () => ({ success: true, dappSummary: {} }) } });
  const p = m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  await Promise.resolve();
  const id = m.list()[0].id;
  await m.resolve(id, false);
  const env = await p;
  assert.equal(env.status, 401); // 4001-class user rejection
  assert.match(env.body.error, /reject/i);
  assert.equal(m.size(), 0);
});

test('sign: enrich marks a locked wallet as needing unlock (no summary, not auto-signed)', async () => {
  const { m } = makeManager({ vault: { decodeDappSpend: () => ({ success: false, code: 'LOCKED' }) } });
  m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  await Promise.resolve();
  await m.enrich();
  const item = m.list()[0];
  assert.equal(item.summary, null);
  assert.equal(item.needsUnlock, true);
});

test('message: signMessage carries the message summary and signs on approve', async () => {
  const { m } = makeManager({ vault: { signMessage: (r) => ({ success: true, signature: '1'.repeat(192), signerPublicKey: 'a'.repeat(96), echo: r.message }) } });
  const p = m.route({ method: 'signMessage', params: { message: 'hello dig' }, origin: ORIGIN });
  await Promise.resolve();
  const item = m.list()[0];
  assert.equal(item.kind, 'signMessage');
  assert.equal(item.summary.message, 'hello dig');
  await m.resolve(item.id, true);
  const env = await p;
  assert.equal(env.status, 200);
  assert.equal(env.body.data.signature, '1'.repeat(192));
  assert.equal(env.body.data.publicKey, 'a'.repeat(96));
});

test('resolve: an unknown id is a no-op NO_PENDING', async () => {
  const { m } = makeManager();
  const ack = await m.resolve('nope', true);
  assert.equal(ack.success, false);
  assert.equal(ack.code, 'NO_PENDING');
});

test('multiple queued requests share one summon and drain independently', async () => {
  const { m, calls } = makeManager({
    vault: {
      decodeDappSpend: () => ({ success: true, dappSummary: {} }),
      signDappSpend: () => ({ success: true, signature: '0'.repeat(192) }),
    },
  });
  const p1 = m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  const p2 = m.route({ method: 'signCoinSpends', params: { coinSpends: WIRE_COIN_SPENDS }, origin: ORIGIN });
  await Promise.resolve();
  assert.equal(m.size(), 2);
  assert.equal(calls.summon, 2); // summon is idempotent-safe; the window focuses if already open
  const ids = m.list().map((i) => i.id);
  assert.equal((await m.resolve(ids[0], true)).remaining, 1);
  assert.equal((await m.resolve(ids[1], false)).remaining, 0);
  assert.equal((await p1).status, 200);
  assert.equal((await p2).status, 401);
});

test('an unsupported (known) method is honestly rejected, not silently signed', async () => {
  const { m, calls } = makeManager();
  const env = await m.route({ method: 'createOffer', params: {}, origin: ORIGIN });
  assert.equal(env.status, 501);
  assert.equal(calls.summon, 0);
});
